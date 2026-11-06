const admin = require('firebase-admin');

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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  
  const path = event.path.replace('/api/', '');

  if (event.httpMethod === 'POST' && path === 'create-invoice') {
    try {
      const { itemId, price, title } = JSON.parse(event.body);
      
      // Проверка лимита для лимитированных скинов
      if (itemId.startsWith('prem_limited') || itemId === 'prem_bag') {
        const itemRef = db.collection('limited_skins').doc(itemId);
        
        await db.runTransaction(async (t) => {
          const doc = await t.get(itemRef);
          if (!doc.exists) {
            t.set(itemRef, { total: itemId === 'prem_bag' ? 1000 : 500, sold: 0 });
          } else {
            const data = doc.data();
            if (data.sold >= data.total) throw new Error('SOLD_OUT');
          }
        });
      }

      const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/createInvoiceLink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title, description: title,
          payload: JSON.stringify({ itemId }),
          provider_token: '', currency: 'XTR',
          prices: [{ label: title, amount: price }]
        })
      });
      
      const data = await r.json();
      return { statusCode: 200, headers, body: JSON.stringify({ invoiceLink: data.result }) };
      
    } catch (err) {
      if (err.message === 'SOLD_OUT') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Тираж распродан!' }) };
      }
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (event.httpMethod === 'POST' && path === 'webhook') {
    try {
      const body = JSON.parse(event.body);
      if (body.message && body.message.successful_payment) {
        const payment = body.message.successful_payment;
        const payload = JSON.parse(payment.invoice_payload);
        const itemId = payload.itemId;
        
        if (itemId.startsWith('prem_limited') || itemId === 'prem_bag') {
          const itemRef = db.collection('limited_skins').doc(itemId);
          await itemRef.update({
            sold: admin.firestore.FieldValue.increment(1)
          });
        }
      }
      return { statusCode: 200, headers, body: 'OK' };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 404, headers, body: JSON.stringify({ error: 'Unknown' }) };
};
