const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

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
    const { name, phone, qty } = req.body;

    if (!name || !phone || !qty) {
      return res.status(400).json({ error: 'Nome, telefone e quantidade são obrigatórios' });
    }

    if (qty < 50) {
      return res.status(400).json({ error: 'Mínimo de 50 cotas (R$ 17,50)' });
    }

    const phoneClean = phone.replace(/\D/g, '');
    const amount = qty * 35; // 35 centavos por cota

    // Busca ou cria usuário
    let { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phoneClean)
      .single();

    if (!user) {
      const { data: newUser, error: userError } = await supabase
        .from('users')
        .insert({ name, phone: phoneClean })
        .select()
        .single();
      if (userError) throw userError;
      user = newUser;
    }

    const externalId = `rifa-${Date.now()}-${user.id.slice(0, 8)}`;
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://rifa-maquinarios-agricolas-dd3jqkz7r.vercel.app';

    // Cria cobrança na BuckPay
    const buckpayRes = await fetch('https://api.realtechdev.com.br/v1/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BUCKPAY_TOKEN}`,
        'User-Agent': process.env.BUCKPAY_USER_AGENT
      },
      body: JSON.stringify({
        external_id: externalId,
        payment_method: 'pix',
        amount,
        buyer: { name, phone: phoneClean },
        postbackUrl: `${baseUrl}/api/webhook`
      })
    });

    const buckpayData = await buckpayRes.json();
    if (!buckpayRes.ok) {
      throw new Error(buckpayData.message || 'Erro na BuckPay');
    }

    // Salva compra no Supabase
    const { error: purchaseError } = await supabase
      .from('purchases')
      .insert({
        user_id: user.id,
        transaction_id: buckpayData.id,
        external_id: externalId,
        qty,
        amount,
        status: 'pending'
      });
    if (purchaseError) throw purchaseError;

    return res.status(200).json({
      pix_code: buckpayData.pix?.code,
      qrcode_base64: buckpayData.pix?.qrcode_base64,
      transaction_id: buckpayData.id,
      total: (amount / 100).toFixed(2)
    });

  } catch (err) {
    console.error('create-charge error:', err);
    return res.status(500).json({ error: err.message });
  }
};
