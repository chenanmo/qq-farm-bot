/**
 * 好友「护主犬已验证」缓存 - 只记录已经确认上场护主犬的好友
 *
 * 与 pet-cache.ts 的区别：
 * - pet-cache 记录的是「今天看到过什么狗」，每日重新确认，只服务于当天的巡查决策；
 * - 本缓存只收 dogId === PROTECT_DOG_ID 的好友，且**跨日保留**：一旦验证过，
 *   后续每日宠物同步直接跳过，不再为这几位额外花 RPC。
 *
 * 结论被推翻的唯一途径是再次进入该好友农场时看到别的狗/没有狗
 * （recordFriendDog 会顺手把它从本缓存删掉），或者用户手动清空宠物缓存。
 */

const crypto = require('node:crypto');
const { getDataFile } = require('../../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../json-db');
const { toNum, getSystemDateKey, logWarn } = require('../../utils/utils');
const { createScheduler } = require('../scheduler');

const CACHE_VERSION: number = 1;
const FLUSH_DEBOUNCE_MS: number = 2000;

interface ProtectDogEntry {
    /** 最后确认有护主犬的日期（系统日期）。 */
    date: string;
    /** 首次验证时间。 */
    verifiedAt: number;
    /** 最后一次确认时间。 */
    checkedAt: number;
}

const protectScheduler: any = createScheduler('friend-protect-dog-cache');

function normalizeId(value: any): number {
    const num: number = Number(toNum(value));
    return Number.isFinite(num) && num > 0 ? Math.trunc(num) : 0;
}

let entries: Map<number, ProtectDogEntry> | null = null;

function getCacheFile(): string {
    const accountId: string = String(process.env.FARM_ACCOUNT_ID || 'default');
    const token: string = crypto.createHash('sha256').update(accountId, 'utf8').digest('hex');
    return getDataFile(`friend-protect-dogs-${token}.json`);
}

function loadCache(): Map<number, ProtectDogEntry> {
    if (entries) return entries;
    const loaded: Map<number, ProtectDogEntry> = new Map();
    try {
        const state: any = readJsonFile(getCacheFile(), () => ({}));
        if (Number(state?.version) === CACHE_VERSION) {
            const raw: any = state?.entries;
            if (raw && typeof raw === 'object') {
                for (const [key, value] of Object.entries(raw)) {
                    const gid: number = normalizeId(key);
                    if (gid <= 0) continue;
                    loaded.set(gid, {
                        date: String((value as any)?.date || ''),
                        verifiedAt: toNum((value as any)?.verifiedAt),
                        checkedAt: toNum((value as any)?.checkedAt),
                    });
                }
            }
        }
    } catch (e: any) {
        logWarn('好友', `读取护主犬验证缓存失败，按空缓存处理: ${e.message}`);
    }
    entries = loaded;
    return entries;
}

function flushCache(): void {
    const store: Map<number, ProtectDogEntry> = loadCache();
    const payload: Record<string, ProtectDogEntry> = {};
    for (const [gid, entry] of store) payload[String(gid)] = entry;
    try {
        writeJsonFileAtomic(getCacheFile(), {
            version: CACHE_VERSION,
            entries: payload,
        });
    } catch (e: any) {
        logWarn('好友', `保存护主犬验证缓存失败: ${e.message}`);
    }
}

function scheduleFlush(): void {
    protectScheduler.setTimeoutTask('friend_protect_dog_cache_flush', FLUSH_DEBOUNCE_MS, () => flushCache());
}

/** 记录/刷新一位好友的「已确认护主犬」结论。 */
export function markProtectDogVerified(friendGid: any): void {
    const gid: number = normalizeId(friendGid);
    if (gid <= 0) return;
    const store: Map<number, ProtectDogEntry> = loadCache();
    const now: number = Date.now();
    const today: string = getSystemDateKey();
    const previous: ProtectDogEntry | undefined = store.get(gid);
    store.set(gid, {
        date: today,
        verifiedAt: previous?.verifiedAt || now,
        checkedAt: now,
    });
    // 同一份结论每天最多落盘一次即可；首次验证或跨日刷新需要写入。
    if (!previous || previous.date !== today) scheduleFlush();
}

/**
 * 推翻「有护主犬」的结论：再次进入该好友农场时看到的是别的狗或没有狗。
 * 之后每日同步会重新把它纳入待确认列表。
 */
export function unmarkProtectDogVerified(friendGid: any): void {
    const gid: number = normalizeId(friendGid);
    if (gid <= 0) return;
    const store: Map<number, ProtectDogEntry> = loadCache();
    if (store.delete(gid)) scheduleFlush();
}

export function isProtectDogVerified(friendGid: any): boolean {
    const gid: number = normalizeId(friendGid);
    if (gid <= 0) return false;
    return loadCache().has(gid);
}

export function getProtectDogVerifiedGids(): number[] {
    return [...loadCache().keys()].sort((a, b) => a - b);
}

export function getProtectDogVerifiedCount(): number {
    return loadCache().size;
}

export function getProtectDogEntries(): Array<{ gid: number; date: string; verifiedAt: number; checkedAt: number }> {
    return getProtectDogVerifiedGids().map(gid => {
        const entry = loadCache().get(gid) as ProtectDogEntry;
        return { gid, date: entry.date, verifiedAt: entry.verifiedAt, checkedAt: entry.checkedAt };
    });
}

/** 清空全部护主犬验证结论，返回清掉的条数。 */
export function clearProtectDogCache(): number {
    const store: Map<number, ProtectDogEntry> = loadCache();
    const count: number = store.size;
    store.clear();
    protectScheduler.clear('friend_protect_dog_cache_flush');
    flushCache();
    return count;
}

/** 停机前把防抖里的待写落盘。 */
export function flushProtectDogCacheNow(): void {
    protectScheduler.clear('friend_protect_dog_cache_flush');
    flushCache();
}

/** 仅供停机与测试使用：丢掉内存态，下次访问重新从文件加载。 */
export function resetProtectDogCacheMemory(): void {
    protectScheduler.clearAll();
    entries = null;
}

module.exports = {
    markProtectDogVerified,
    unmarkProtectDogVerified,
    isProtectDogVerified,
    getProtectDogVerifiedGids,
    getProtectDogVerifiedCount,
    getProtectDogEntries,
    clearProtectDogCache,
    flushProtectDogCacheNow,
    resetProtectDogCacheMemory,
};
