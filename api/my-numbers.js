const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Telefone obrigatório' });

    const phoneClean = phone.replace(/\D/g, '');

    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phoneClean)
      .single();

    if (!user) return res.status(200).json({ purchases: [] });

    const { data: purchases } = await supabase
      .from('purchases')
      .select('qty, amount, status, numbers, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    return res.status(200).json({ user: { name: user.name, phone: user.phone }, purchases: purchases || [] });
  } catch (err) {
    console.error('my-numbers error:', err);
    return res.status(500).json({ error: err.message });
  }
};
