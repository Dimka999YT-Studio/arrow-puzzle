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
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (event.httpMethod === 'POST' && path === 'webhook') {
    return { statusCode: 200, headers, body: 'OK' };
  }

  return { statusCode: 404, headers, body: JSON.stringify({ error: 'Unknown' }) };
};
