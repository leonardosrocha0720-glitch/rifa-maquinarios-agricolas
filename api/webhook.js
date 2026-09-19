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
    const { event, status, id: transaction_id } = req.body;

    if (event === 'transaction.processed' && status === 'paid') {
      const { data: purchase } = await supabase
        .from('purchases')
        .select('*')
        .eq('transaction_id', transaction_id)
        .eq('status', 'pending')
        .single();

      if (purchase) {
        const numbers = generateNumbers(purchase.qty);
        await supabase
          .from('purchases')
          .update({ status: 'paid', numbers })
          .eq('id', purchase.id);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
};
