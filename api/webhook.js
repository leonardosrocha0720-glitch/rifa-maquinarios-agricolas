const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function generateNumbers(qty, max = 100000) {
  const set = new Set();
  while (set.size < qty) {
    set.add(Math.floor(Math.random() * max) + 1);
  }
  return Array.from(set).sort((a, b) => a - b);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    // A BuckPay envelopa a transação em "data" na criação da cobrança; aceitamos
    // as duas formas para o postback até confirmar o formato com o suporte.
    const payload = req.body || {};
    const tx = payload.data || payload;
    const event = payload.event || tx.event;
    const status = tx.status || payload.status;
    const transaction_id = tx.id || payload.id;

    console.log('webhook recebido:', JSON.stringify({ event, status, transaction_id }));

    if (event === 'transaction.processed' && status === 'paid') {
      const { data: purchase } = await supabase
        .from('purchases')
        .select('*')
        .eq('transaction_id', transaction_id)
        .eq('status', 'pending')
        .maybeSingle();

      if (!purchase) {
        console.error('webhook: nenhuma compra pendente para transaction_id', transaction_id);
      } else {
        const numbers = generateNumbers(purchase.qty);
        const { error: updateError } = await supabase
          .from('purchases')
          .update({ status: 'paid', numbers })
          .eq('id', purchase.id);
        if (updateError) throw updateError;
        console.log('webhook: compra', purchase.id, 'paga —', numbers.length, 'números gerados');
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
};
