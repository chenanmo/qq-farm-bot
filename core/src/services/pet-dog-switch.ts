export {};

/**
 * 护主犬礼包次数用完自动切比熊。
 *
 * 护主犬（90021）的「同气连枝」每天最多掉 30 个礼包，次数用完后继续挂着没有收益；
 * 比熊（90031）的「比熊润田」在看护状态下有概率触发比熊变异，正好接替这段空窗。
 * 次日次数恢复（或服务端下发还剩次数）时再切回护主犬。
 *
 * 判断依据只有 GetDogInfo 的 skill_usages（skill 2001 / dog 90021）：
 * used_count 与 daily_limit 已在游戏内逐项核对过（used=7、limit=30 → 页面 23/30）。
 *
 * 服务端在护主犬未上场时是否仍下发这条 usage 没有抓包证明，因此这里额外记一个
 * 「今天已经用完」的日期：usage 缺失时，如果今天已经确认用完就继续留在比熊，
 * 避免在两个 tick 之间来回切换；跨日后记忆失效，默认按次数已恢复处理。
 */

const crypto = require('node:crypto');
const { getDataFile } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');
const { isAutomationOn } = require('../models/store');
const { getDogInfo } = require('./dog-skill-gifts');
const { deployDog } = require('./pets');
const { toNum, getSystemDateKey, log, logWarn } = require('../utils/utils');

const GUARD_DOG_ID: number = 90021;
const BICHON_DOG_ID: number = 90031;
const GUARD_GIFT_SKILL_ID: number = 2001;
/** 技能说明写死的每日上限；服务端 daily_limit 缺失时兜底。 */
const GUARD_GIFT_DAILY_LIMIT: number = 30;

const CHECK_INTERVAL_MS: number = 10 * 60 * 1000;
const INITIAL_DELAY_MS: number = 150 * 1000;

interface DogSwitchMemory {
    /** 最近一次确认「护主犬礼包次数用完」的日期；跨日自动失效。 */
    exhaustedDateKey: string;
}

export interface DogSwitchState {
    activeDogId: number;
    hasGuardDog: boolean;
    hasBichon: boolean;
    /** 服务端是否下发了同气连枝的使用记录；false 时次数视为未知。 */
    guardGiftKnown: boolean;
    guardGiftDailyLimit: number;
    guardGiftUsedCount: number;
    guardGiftRemaining: number;
    pendingGiftCount: number;
}

export type DogSwitchAction = 'keep' | 'deploy_guard' | 'deploy_bichon';

export interface DogSwitchPlan {
    action: DogSwitchAction;
    reason: string;
    targetDogId?: number;
    /** 护主犬礼包次数是否已确认用完。 */
    exhausted: boolean;
}

function normalizeId(value: any): number {
    const num: number = Number(toNum(value));
    return Number.isFinite(num) && num > 0 ? Math.trunc(num) : 0;
}

function getMemoryFile(): string {
    const accountId: string = String(process.env.FARM_ACCOUNT_ID || 'default');
    const token: string = crypto.createHash('sha256').update(accountId, 'utf8').digest('hex');
    return getDataFile(`pet-dog-switch-${token}.json`);
}

let memory: DogSwitchMemory | null = null;

function loadMemory(): DogSwitchMemory {
    if (memory) return memory;
    let loaded: DogSwitchMemory = { exhaustedDateKey: '' };
    try {
        const state: any = readJsonFile(getMemoryFile(), () => ({}));
        loaded = { exhaustedDateKey: String(state?.exhaustedDateKey || '') };
    } catch (e: any) {
        logWarn('宠物', `读取护主犬切换记录失败，按空记录处理: ${e.message}`, {
            module: 'dog', event: '护主犬自动切换', result: 'error',
        });
    }
    memory = loaded;
    return memory;
}

function saveMemory(): void {
    try {
        writeJsonFileAtomic(getMemoryFile(), loadMemory());
    } catch (e: any) {
        logWarn('宠物', `保存护主犬切换记录失败: ${e.message}`, {
            module: 'dog', event: '护主犬自动切换', result: 'error',
        });
    }
}

function updateExhaustedMemory(exhausted: boolean, today: string): void {
    const state = loadMemory();
    const next = exhausted ? today : '';
    if (state.exhaustedDateKey === next) return;
    state.exhaustedDateKey = next;
    saveMemory();
}

/** 把 GetDogInfo 原始回包转成切换判断需要的字段。 */
export function buildDogSwitchState(reply: any): DogSwitchState {
    const dogs: any[] = Array.isArray(reply?.dogs) ? reply.dogs : [];
    const activeDogId = normalizeId(reply?.current_dog_id ?? reply?.currentDogId);
    const owned = new Set<number>();
    for (const dog of dogs) {
        const id = normalizeId(dog?.id);
        if (id <= 0) continue;
        // owned 是已获得；当前上场的狗按已获得处理，避免回包短暂缺字段。
        if (normalizeId(dog?.owned ?? dog?.field_7) === 1 || id === activeDogId) owned.add(id);
    }

    const rawUsages = reply?.skill_usages ?? reply?.skillUsages;
    const usages: any[] = Array.isArray(rawUsages) ? rawUsages : [];
    const usage = usages.find((entry: any) => (
        normalizeId(entry?.skill_id ?? entry?.skillId) === GUARD_GIFT_SKILL_ID
        && normalizeId(entry?.dog_id ?? entry?.dogId) === GUARD_DOG_ID
    ));
    const protocolLimit = Math.max(0, normalizeId(usage?.daily_limit ?? usage?.dailyLimit));
    const dailyLimit = protocolLimit || GUARD_GIFT_DAILY_LIMIT;
    const usedCount = Math.max(0, normalizeId(usage?.used_count ?? usage?.usedCount));

    return {
        activeDogId,
        hasGuardDog: owned.has(GUARD_DOG_ID),
        hasBichon: owned.has(BICHON_DOG_ID),
        guardGiftKnown: !!usage,
        guardGiftDailyLimit: dailyLimit,
        guardGiftUsedCount: usedCount,
        guardGiftRemaining: Math.max(0, dailyLimit - usedCount),
        pendingGiftCount: Math.max(0, normalizeId(reply?.pending_gift_count ?? reply?.pendingGiftCount)),
    };
}

/**
 * 纯判断：这一轮该不该换狗。
 * options.today 与 exhaustedDateKey 用来处理「护主犬没上场时服务端不下发 usage」：
 * 今天已经确认用完的，即使拿不到 usage 也继续留在比熊。
 */
export function planDogSwitch(
    state: DogSwitchState,
    options: { today?: string; exhaustedDateKey?: string } = {},
): DogSwitchPlan {
    if (!state.hasGuardDog) return { action: 'keep', reason: 'no_guard_dog', exhausted: false };
    if (!state.hasBichon) return { action: 'keep', reason: 'no_bichon', exhausted: false };

    const today: string = options.today || '';
    const exhaustedToday: boolean = state.guardGiftKnown
        ? state.guardGiftRemaining <= 0
        : !!today && options.exhaustedDateKey === today;

    if (!exhaustedToday) {
        if (state.activeDogId === GUARD_DOG_ID) {
            return { action: 'keep', reason: 'guard_active_with_gifts', exhausted: false };
        }
        return {
            action: 'deploy_guard',
            reason: state.guardGiftKnown ? 'guard_gifts_available' : 'guard_gifts_unknown',
            targetDogId: GUARD_DOG_ID,
            exhausted: false,
        };
    }

    if (state.activeDogId === BICHON_DOG_ID) {
        return { action: 'keep', reason: 'bichon_active_no_gifts', exhausted: true };
    }
    return {
        action: 'deploy_bichon',
        reason: 'guard_gifts_exhausted',
        targetDogId: BICHON_DOG_ID,
        exhausted: true,
    };
}

let running: boolean = false;

/**
 * 执行一次检查。切换本身是写操作，必须串在自动任务全局锁里调用
 * （worker 侧用 runExclusiveAutomationTask('pet_dog_switch', ...)）。
 */
export async function runPetDogSwitch(): Promise<any> {
    if (!isAutomationOn('pet_guard_dog_auto_switch')) {
        return { skipped: true, reason: 'switch_off' };
    }
    if (running) return { skipped: true, reason: 'running' };

    running = true;
    try {
        const state: DogSwitchState = buildDogSwitchState(await getDogInfo());
        const today: string = getSystemDateKey();
        const plan: DogSwitchPlan = planDogSwitch(state, {
            today,
            exhaustedDateKey: loadMemory().exhaustedDateKey,
        });

        if (plan.action === 'keep') {
            updateExhaustedMemory(plan.exhausted, today);
            return { ...state, ...plan, switched: false };
        }

        await deployDog(plan.targetDogId);
        updateExhaustedMemory(plan.exhausted, today);
        const message: string = plan.action === 'deploy_bichon'
            ? `护主犬今日同气连枝礼包已用完（${state.guardGiftUsedCount}/${state.guardGiftDailyLimit}），自动切换比熊上场`
            : `检测到护主犬今日仍有礼包次数（剩余 ${state.guardGiftRemaining}/${state.guardGiftDailyLimit}），自动切换护主犬上场`;
        log('宠物', message, {
            module: 'dog',
            event: '护主犬自动切换',
            result: 'ok',
            dogId: plan.targetDogId,
            remaining: state.guardGiftRemaining,
            pendingGifts: state.pendingGiftCount,
        });
        return { ...state, ...plan, switched: true };
    } catch (e: any) {
        logWarn('宠物', `护主犬自动切换失败: ${e?.message || e}`, {
            module: 'dog', event: '护主犬自动切换', result: 'error',
        });
        return { error: String(e?.message || e || '切换失败') };
    } finally {
        running = false;
    }
}

/** 仅供测试使用：丢掉内存记录，下次重新读盘。 */
export function resetPetDogSwitchMemory(): void {
    memory = null;
}

module.exports = {
    GUARD_DOG_ID,
    BICHON_DOG_ID,
    GUARD_GIFT_SKILL_ID,
    GUARD_GIFT_DAILY_LIMIT,
    CHECK_INTERVAL_MS,
    INITIAL_DELAY_MS,
    buildDogSwitchState,
    planDogSwitch,
    runPetDogSwitch,
    resetPetDogSwitchMemory,
};
