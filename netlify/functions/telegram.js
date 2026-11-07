const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (e) {
    console.error("Firebase init error:", e);
  }
}

const db = admin.firestore();

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
// Канал для проверки подписки: '@username' или числовой id (-100...). Бот должен быть администратором канала.
const SUBSCRIBE_CHANNEL = process.env.SUBSCRIBE_CHANNEL;
// Тираж «Пакетика» стартует с того же числа, которое игроки видят сейчас (state.bagSold = 450).
const BAG_START_SOLD = 450;
const BAG_TOTAL = 1000;

// Серверный каталог. Цена и название берутся ТОЛЬКО отсюда, а не от клиента,
// иначе скин за 999 звёзд можно купить, отправив price: 1.
// Должен совпадать с DONATE_ITEMS в index.html.
const CATALOG = {
  // кристаллы
  pack1: { name: 'Горсть', price: 25 },
  pack2: { name: 'Мешок', price: 75 },
  pack3: { name: 'Сундук', price: 125 },
  pack4: { name: 'Сокровищница', price: 225 },
  pack5: { name: 'Легенда', price: 350 },
  pack6: { name: 'Мега-легенда', price: 950 },
  // скины
  prem_neon: { name: 'Неон', price: 50 },
  prem_gold: { name: 'Золото', price: 105 },
  prem_crystal: { name: 'Кристалл', price: 150 },
  prem_rainbow: { name: 'Радуга', price: 230 },
  prem_holo: { name: 'Голограмма', price: 375 },
  prem_youtube: { name: 'YouTube', price: 999 },
  prem_flower: { name: 'Цветочек', price: 999 },
  prem_nine: { name: 'Девятка', price: 999 },
  prem_globe: { name: 'Глобус', price: 999 },
  prem_cloud: { name: 'Туча', price: 999 },
  prem_alarm: { name: 'Будильник', price: 999 },
  prem_candy: { name: 'Конфетка', price: 999 },
  prem_firework: { name: 'Фейерверк', price: 999 },
  prem_crown: { name: 'Корона', price: 999 },
  prem_bag: { name: 'Пакетик', price: 999 },
  // темы
  prem_cyberpunk: { name: 'Киберпанк', price: 59 },
  prem_matrix: { name: 'Матрица', price: 125 },
  prem_galaxy: { name: 'Галактика', price: 250 },
  prem_ice: { name: 'Ледяная', price: 350 },
  prem_volcano: { name: 'Вулкан', price: 350 },
  prem_gift_black: { name: 'Чёрная', price: 999 },
  // особые
  no_ads: { name: 'Убрать рекламу', price: 359 },
  double_crystals: { name: 'Двойные кристаллы', price: 118 },
  infinite_undo: { name: 'Бесконечные отмены', price: 235 },
  infinite_hint: { name: 'Бесконечные подсказки', price: 235 },
  // наборы
  starter: { name: 'Стартовый набор', price: 100 },
  beginner: { name: 'Набор новичка', price: 250 },
  player: { name: 'Набор игрока', price: 350 },
  mega: { name: 'Мега-набор', price: 500 }
};

function isLimited(itemId) {
  return itemId.startsWith('prem_limited') || itemId === 'prem_bag';
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// Проверка подписи Telegram initData. Возвращает объект user или null.
function verifyTelegramData(initData, botToken) {
  try {
    if (!initData || !botToken) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (!safeEqual(calculated, hash)) return null;

    const userStr = params.get('user');
    if (!userStr) return null;
    const user = JSON.parse(userStr);
    return user && user.id ? user : null;
  } catch (e) {
    return null;
  }
}

function parseBody(event) {
  try { return JSON.parse(event.body || '{}'); } catch (e) { return {}; }
}

function getHeader(event, name) {
  const h = event.headers || {};
  for (const k in h) { if (k.toLowerCase() === name) return h[k]; }
  return '';
}

async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return r.json();
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };
  const json = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // последний сегмент пути: работает и для /api/xxx, и для /.netlify/functions/telegram/xxx
  const path = event.path.split('/').filter(Boolean).pop();

  // 1. СОЗДАНИЕ СЧЁТА
  if (event.httpMethod === 'POST' && path === 'create-invoice') {
    try {
      const b = parseBody(event);
      const user = verifyTelegramData(b.initData, BOT_TOKEN);
      if (!user) return json(401, { error: 'Unauthorized' });
      const userId = String(user.id);

      let itemId = String(b.itemId || '');
      let price, title;
      if (itemId.startsWith('support_')) {
        price = parseInt(b.price, 10);
        if (!(price >= 5 && price <= 10000)) return json(400, { error: 'Bad amount' });
        title = 'Поддержка Dimka999YT Studio';
        itemId = 'support';
      } else {
        const item = CATALOG[itemId];
        if (!item) return json(400, { error: 'Unknown item' });
        price = item.price;
        title = item.name;
      }

      // Проверка лимита для лимитированных скинов
      if (isLimited(itemId)) {
        const itemRef = db.collection('limited_skins').doc(itemId);
        await db.runTransaction(async (t) => {
          const doc = await t.get(itemRef);
          if (!doc.exists) {
            t.set(itemRef, itemId === 'prem_bag' ? { total: BAG_TOTAL, sold: BAG_START_SOLD } : { total: 500, sold: 0 });
          } else {
            const data = doc.data();
            if (data.sold >= data.total) throw new Error('SOLD_OUT');
          }
        });
      }

      // Заказ создаём до счёта, чтобы вебхук всегда мог его найти.
      // В payload счёта уходит только случайный orderId, а кто и что купил — хранится здесь.
      const orderId = crypto.randomBytes(12).toString('hex');
      const orderRef = db.collection('purchases').doc(orderId);
      await orderRef.set({
        userId, itemId, price,
        status: 'pending',
        claimed: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const data = await tg('createInvoiceLink', {
        title, description: title,
        payload: orderId,
        provider_token: '', currency: 'XTR',
        prices: [{ label: title, amount: price }]
      });
      if (!data.ok) {
        await orderRef.delete().catch(() => {});
        throw new Error(data.description || 'Telegram API error');
      }

      return json(200, { invoiceLink: data.result });

    } catch (err) {
      if (err.message === 'SOLD_OUT') return json(400, { error: 'Тираж распродан!' });
      console.error('create-invoice error:', err);
      return json(500, { error: 'Server error' });
    }
  }

  // 2. ПОКУПКИ ИГРОКА (игра спрашивает при загрузке и после оплаты)
  // ack — id заказов, которые клиент уже выдал и сохранил: сервер помечает их claimed.
  if (event.httpMethod === 'POST' && path === 'get-purchases') {
    try {
      const b = parseBody(event);
      const user = verifyTelegramData(b.initData, BOT_TOKEN);
      if (!user) return json(401, { error: 'Unauthorized' });
      const userId = String(user.id);

      if (Array.isArray(b.ack) && b.ack.length) {
        const ids = b.ack.filter((id) => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id)).slice(0, 100);
        if (ids.length) {
          const refs = ids.map((id) => db.collection('purchases').doc(id));
          const snaps = await db.getAll(...refs);
          const batch = db.batch();
          snaps.forEach((s) => {
            if (s.exists) {
              const o = s.data();
              if (o.userId === userId && o.status === 'completed' && !o.claimed) {
                batch.update(s.ref, { claimed: true });
              }
            }
          });
          await batch.commit();
        }
      }

      const snapshot = await db.collection('purchases')
        .where('userId', '==', userId)
        .where('status', '==', 'completed')
        .where('claimed', '==', false)
        .limit(100)
        .get();
      const purchases = [];
      snapshot.forEach((doc) => purchases.push({ id: doc.id, itemId: doc.data().itemId }));

      return json(200, { purchases });
    } catch (err) {
      console.error('get-purchases error:', err);
      return json(500, { error: 'Server error' });
    }
  }

  // 3. ПРОВЕРКА ПОДПИСКИ НА КАНАЛ
  if (event.httpMethod === 'POST' && path === 'check-subscription') {
    try {
      const b = parseBody(event);
      const user = verifyTelegramData(b.initData, BOT_TOKEN);
      if (!user) return json(401, { error: 'Unauthorized' });
      if (!SUBSCRIBE_CHANNEL) return json(200, { subscribed: false, configured: false });

      const r = await tg('getChatMember', { chat_id: SUBSCRIBE_CHANNEL, user_id: user.id });
      if (!r.ok) {
        console.error('getChatMember failed:', r.description);
        return json(200, { subscribed: false, error: true });
      }
      const st = r.result && r.result.status;
      const subscribed = st === 'creator' || st === 'administrator' || st === 'member' ||
        (st === 'restricted' && r.result.is_member === true);
      return json(200, { subscribed });
    } catch (err) {
      console.error('check-subscription error:', err);
      return json(500, { error: 'Server error' });
    }
  }

  // 4. ТИРАЖ «ПАКЕТИКА» (публичные данные, подпись не нужна)
  if ((event.httpMethod === 'POST' || event.httpMethod === 'GET') && path === 'get-sold') {
    try {
      const ref = db.collection('limited_skins').doc('prem_bag');
      let snap = await ref.get();
      if (!snap.exists) {
        await ref.set({ total: BAG_TOTAL, sold: BAG_START_SOLD }, { merge: true });
        snap = await ref.get();
      }
      const d = snap.data();
      return json(200, { sold: d.sold || 0, total: d.total || BAG_TOTAL });
    } catch (err) {
      console.error('get-sold error:', err);
      return json(500, { error: 'Server error' });
    }
  }

  // 5. ВЕБХУК TELEGRAM (pre_checkout_query и successful_payment)
  if (event.httpMethod === 'POST' && path === 'webhook') {
    // Без секрета любой мог бы прислать поддельное «оплачено», поэтому без него не работаем.
    if (!WEBHOOK_SECRET) {
      console.error('WEBHOOK_SECRET is not set, webhook rejected');
      return json(503, { error: 'Webhook is not configured' });
    }
    if (!safeEqual(getHeader(event, 'x-telegram-bot-api-secret-token'), WEBHOOK_SECRET)) {
      return json(403, { error: 'Forbidden' });
    }

    try {
      const update = parseBody(event);

      // Telegram ждёт ответ на pre_checkout_query в течение 10 секунд
      if (update.pre_checkout_query) {
        const q = update.pre_checkout_query;
        let ok = false;
        let errorMessage = 'Заказ не найден. Попробуйте ещё раз.';
        const snap = await db.collection('purchases').doc(String(q.invoice_payload)).get();
        if (snap.exists) {
          const o = snap.data();
          if (o.status === 'completed') errorMessage = 'Этот счёт уже оплачен.';
          else if (o.status === 'pending' && o.price === q.total_amount && q.currency === 'XTR') ok = true;
          else errorMessage = 'Неверная сумма счёта.';
        }
        const payload = { pre_checkout_query_id: q.id, ok };
        if (!ok) payload.error_message = errorMessage;
        await tg('answerPreCheckoutQuery', payload);
        return { statusCode: 200, headers, body: 'OK' };
      }

      const sp = update.message && update.message.successful_payment;
      if (sp) {
        const orderRef = db.collection('purchases').doc(String(sp.invoice_payload));
        await db.runTransaction(async (t) => {
          const snap = await t.get(orderRef);
          if (!snap.exists) { console.error('Payment for unknown order:', sp.invoice_payload); return; }
          const o = snap.data();
          if (o.status === 'completed') return; // повторная доставка вебхука

          if (sp.currency !== 'XTR' || sp.total_amount !== o.price) {
            console.error('Amount mismatch for order', snap.id, sp.total_amount, o.price);
            t.update(orderRef, { status: 'review', chargeId: sp.telegram_payment_charge_id });
            return;
          }

          t.update(orderRef, {
            status: 'completed',
            claimed: o.itemId === 'support', // донат выдавать нечем
            chargeId: sp.telegram_payment_charge_id,
            completedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          if (isLimited(o.itemId)) {
            t.set(db.collection('limited_skins').doc(o.itemId),
              { sold: admin.firestore.FieldValue.increment(1) }, { merge: true });
          }
        });
      }
      return { statusCode: 200, headers, body: 'OK' };
    } catch (err) {
      console.error('webhook error:', err);
      return json(500, { error: 'Server error' }); // Telegram повторит доставку, обработка идемпотентна
    }
  }

  return json(404, { error: 'Unknown' });
};
