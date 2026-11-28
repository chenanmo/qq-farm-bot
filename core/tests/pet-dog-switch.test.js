const assert = require('node:assert/strict');
const test = require('node:test');

const {
    GUARD_DOG_ID,
    BICHON_DOG_ID,
    GUARD_GIFT_DAILY_LIMIT,
    buildDogSwitchState,
    planDogSwitch,
} = require('../dist/services/pet-dog-switch');

function dogInfo(overrides = {}) {
    return {
        current_dog_id: 0,
        dogs: [
            { id: 90001, owned: 1 },
            { id: GUARD_DOG_ID, owned: 1 },
            { id: BICHON_DOG_ID, owned: 1 },
        ],
        skill_usages: [],
        pending_gift_count: 0,
        ...overrides,
    };
}

function usage(usedCount, dailyLimit = GUARD_GIFT_DAILY_LIMIT) {
    return { skill_id: 2001, dog_id: GUARD_DOG_ID, used_count: usedCount, daily_limit: dailyLimit };
}

test('解析 GetDogInfo：已获得宠物、当前上场与同气连枝次数', () => {
    const state = buildDogSwitchState(dogInfo({
        current_dog_id: GUARD_DOG_ID,
        skill_usages: [usage(7)],
        pending_gift_count: 3,
    }));
    assert.equal(state.activeDogId, GUARD_DOG_ID);
    assert.equal(state.hasGuardDog, true);
    assert.equal(state.hasBichon, true);
    assert.equal(state.guardGiftKnown, true);
    assert.equal(state.guardGiftDailyLimit, 30);
    assert.equal(state.guardGiftUsedCount, 7);
    assert.equal(state.guardGiftRemaining, 23);
    assert.equal(state.pendingGiftCount, 3);
});

test('没有下发同气连枝 usage 时次数视为未知', () => {
    const state = buildDogSwitchState(dogInfo());
    assert.equal(state.guardGiftKnown, false);
    assert.equal(state.guardGiftRemaining, GUARD_GIFT_DAILY_LIMIT);
});

test('没有护主犬或不比熊时保持当前宠物', () => {
    const noGuard = buildDogSwitchState(dogInfo({ dogs: [{ id: BICHON_DOG_ID, owned: 1 }] }));
    assert.equal(planDogSwitch(noGuard).action, 'keep');
    assert.equal(planDogSwitch(noGuard).reason, 'no_guard_dog');

    const noBichon = buildDogSwitchState(dogInfo({ dogs: [{ id: GUARD_DOG_ID, owned: 1 }] }));
    assert.equal(planDogSwitch(noBichon).action, 'keep');
    assert.equal(planDogSwitch(noBichon).reason, 'no_bichon');
});

test('护主犬还有礼包次数但没上场时切回护主犬', () => {
    const state = buildDogSwitchState(dogInfo({
        current_dog_id: BICHON_DOG_ID,
        skill_usages: [usage(7)],
    }));
    const plan = planDogSwitch(state);
    assert.equal(plan.action, 'deploy_guard');
    assert.equal(plan.targetDogId, GUARD_DOG_ID);
    assert.equal(plan.exhausted, false);
});

test('护主犬有次数且已经上场时不重复发请求', () => {
    const state = buildDogSwitchState(dogInfo({
        current_dog_id: GUARD_DOG_ID,
        skill_usages: [usage(7)],
    }));
    assert.equal(planDogSwitch(state).action, 'keep');
    assert.equal(planDogSwitch(state).reason, 'guard_active_with_gifts');
});

test('礼包次数用完时切换比熊', () => {
    const state = buildDogSwitchState(dogInfo({
        current_dog_id: GUARD_DOG_ID,
        skill_usages: [usage(30)],
    }));
    const plan = planDogSwitch(state);
    assert.equal(plan.action, 'deploy_bichon');
    assert.equal(plan.targetDogId, BICHON_DOG_ID);
    assert.equal(plan.exhausted, true);
});

test('使用次数超过上限也按用完处理，且不会出现负数剩余', () => {
    const state = buildDogSwitchState(dogInfo({
        current_dog_id: GUARD_DOG_ID,
        skill_usages: [usage(35)],
    }));
    assert.equal(state.guardGiftRemaining, 0);
    assert.equal(planDogSwitch(state).action, 'deploy_bichon');
});

test('比熊已经上场且次数用完时保持不动', () => {
    const state = buildDogSwitchState(dogInfo({
        current_dog_id: BICHON_DOG_ID,
        skill_usages: [usage(30)],
    }));
    assert.equal(planDogSwitch(state).action, 'keep');
    assert.equal(planDogSwitch(state).reason, 'bichon_active_no_gifts');
});

test('拿不到 usage 时，当天已确认用完就继续留在比熊，跨日恢复护主犬', () => {
    const state = buildDogSwitchState(dogInfo({ current_dog_id: BICHON_DOG_ID }));
    const today = '2026-11-29';

    const sameDay = planDogSwitch(state, { today, exhaustedDateKey: today });
    assert.equal(sameDay.action, 'keep');
    assert.equal(sameDay.reason, 'bichon_active_no_gifts');

    const nextDay = planDogSwitch(state, { today, exhaustedDateKey: '2026-11-28' });
    assert.equal(nextDay.action, 'deploy_guard');

    const noMemory = planDogSwitch(state, { today, exhaustedDateKey: '' });
    assert.equal(noMemory.action, 'deploy_guard');
});

test('拿不到 usage 且护主犬已上场时不清空当前选择', () => {
    const state = buildDogSwitchState(dogInfo({ current_dog_id: GUARD_DOG_ID }));
    assert.equal(planDogSwitch(state, { today: '2026-11-29', exhaustedDateKey: '' }).action, 'keep');
});
