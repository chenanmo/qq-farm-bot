const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const protobuf = require('protobufjs');

// 分享标识存档按数据目录落盘；测试用独立临时目录，避免污染真实账号数据。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yshf-share-key-'));
process.env.FARM_DATA_DIR = dataDir;

const shareKeys = require('../dist/models/store/yishu-share-keys');

test.after(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const UUID = '0d0e525c-1f3e-4133-89d6-da336d845e29';

async function loadRoot() {
    const root = new protobuf.Root();
    await root.load([
        path.join(__dirname, '../src/proto/activitypb.proto'),
        path.join(__dirname, '../src/proto/corepb.proto'),
    ], { keepCase: true });
    return root;
}

test('分享标识可以从 UUID、32 位十六进制与整条分享链接里解析出来', () => {
    assert.equal(shareKeys.normalizeShareKey(UUID), UUID);
    assert.equal(shareKeys.normalizeShareKey(UUID.toUpperCase()), UUID);
    assert.equal(
        shareKeys.normalizeShareKey('0d0e525c1f3e413389d6da336d845e29'),
        UUID,
    );
    assert.equal(
        shareKeys.normalizeShareKey(`https://h5.qq.com/act/farm?gid=1001&share_key=${UUID}&from=card`),
        UUID,
    );
    assert.equal(shareKeys.normalizeShareKey('不是标识'), '');
    assert.equal(shareKeys.isValidShareKey(UUID), true);
    assert.equal(shareKeys.isValidShareKey('0d0e525c1f3e413389d6da336d845e29'), false);
});

test('标识按 gid 落盘，跨日读取按日期失效', () => {
    const today = '2026-11-28';
    assert.equal(shareKeys.writeYishuShareKey('1006086548', {
        shareKey: UUID,
        activityId: '2026111708',
        dateKey: today,
        source: 'manual',
    }), true);

    const entry = shareKeys.readYishuShareKey('1006086548');
    assert.equal(entry.shareKey, UUID);
    assert.equal(entry.dateKey, today);
    assert.equal(entry.source, 'manual');
    assert.deepEqual(shareKeys.findYishuShareKey('1006086548', today), {
        shareKey: UUID,
        activityId: '2026111708',
    });
    // 跨日：服务端会换新标识，旧值一律当没有。
    assert.equal(shareKeys.findYishuShareKey('1006086548', '2026-11-29'), null);

    const all = shareKeys.listYishuShareKeys();
    assert.equal(all.get('1006086548')?.shareKey, UUID);

    assert.equal(shareKeys.removeYishuShareKey('1006086548'), true);
    assert.equal(shareKeys.readYishuShareKey('1006086548'), null);
    assert.equal(shareKeys.removeYishuShareKey('1006086548'), false);
});

test('cmd 93 卖好友时分享引用落在 params.shop（field 3）', async () => {
    const root = await loadRoot();
    const SellRequest = root.lookupType('gamepb.activitypb.YshfSellRequest');
    const Ref = root.lookupType('gamepb.activitypb.YshfShopRef');
    const refBytes = Buffer.from(Ref.encode(Ref.create({
        activity_id: '2026111708', gid: '1006086548', share_key: UUID,
    })).finish());
    const bytes = Buffer.from(SellRequest.encode(SellRequest.create({
        activity_id: '2026111708',
        cmd: 93,
        params: {
            shop_gid: '1006086548',
            count: '30',
            shop: { activity_id: '2026111708', gid: '1006086548', share_key: UUID },
        },
    })).finish());
    const decoded = SellRequest.decode(bytes);
    assert.equal(String(decoded.params.shop_gid), '1006086548');
    assert.equal(String(decoded.params.count), '30');
    assert.equal(decoded.params.shop.share_key, UUID);
    assert.equal(String(decoded.params.shop.gid), '1006086548');
    // Params 内 shop 是 3 号字段（wire type 2），后跟分享引用子消息。
    const expected = `1a${refBytes.length.toString(16).padStart(2, '0')}${refBytes.toString('hex')}`;
    assert.ok(bytes.toString('hex').includes(expected));
});

test('cmd 92 查好友铺子时分享引用落在 params.shop（field 2）', async () => {
    const root = await loadRoot();
    const QueryRequest = root.lookupType('gamepb.activitypb.YshfShopQueryRequest');
    const Ref = root.lookupType('gamepb.activitypb.YshfShopRef');
    const refBytes = Buffer.from(Ref.encode(Ref.create({
        activity_id: '2026111708', gid: '1006086548', share_key: UUID,
    })).finish());
    const bytes = Buffer.from(QueryRequest.encode(QueryRequest.create({
        activity_id: '2026111708',
        cmd: 92,
        params: {
            shop_gid: '1006086548',
            shop: { activity_id: '2026111708', gid: '1006086548', share_key: UUID },
        },
    })).finish());
    const decoded = QueryRequest.decode(bytes);
    assert.equal(decoded.params.shop.share_key, UUID);
    // Params 内 shop 是 2 号字段（wire type 2），后跟分享引用子消息。
    const expected = `12${refBytes.length.toString(16).padStart(2, '0')}${refBytes.toString('hex')}`;
    assert.ok(bytes.toString('hex').includes(expected));
});

test('cmd 97 目录 6 号位是累计已兑换次数', async () => {
    const root = await loadRoot();
    const Goods = root.lookupType('gamepb.activitypb.YshfCatalogGoods');
    const bytes = Buffer.from(Goods.encode(Goods.create({
        index: 2,
        price: '60000',
        status: 2,
        limit: 28,
        exchanged: 13,
    })).finish());
    const hex = bytes.toString('hex');
    // 6 号字段 varint：30 0d（13）。
    assert.ok(hex.includes('300d'));
    const decoded = Goods.decode(bytes);
    assert.equal(Number(decoded.limit), 28);
    assert.equal(Number(decoded.exchanged), 13);
});

test('cmd 98 分享回包的 5 号位 shop_ref 带分享标识', async () => {
    const root = await loadRoot();
    const ShareReply = root.lookupType('gamepb.activitypb.YshfShareReply');
    const bytes = Buffer.from(ShareReply.encode(ShareReply.create({
        grant: { item_id: '20307', count: '4' },
        price: '144',
        shop: {
            gid: '1006086548',
            invite_key: '52ab5e16994b4110b4c7ff79367fce03',
            shop_ref: { activity_id: '2026111708', gid: '1006086548', share_key: UUID },
        },
    })).finish());
    const decoded = ShareReply.decode(bytes);
    assert.equal(decoded.shop.invite_key, '52ab5e16994b4110b4c7ff79367fce03');
    assert.equal(decoded.shop.shop_ref.share_key, UUID);
    // SelfShop 内 shop_ref 是 5 号字段：2a…；UUID 的 UTF-8 必须出现在报文里。
    assert.ok(bytes.toString('hex').includes(Buffer.from(UUID).toString('hex')));
});
