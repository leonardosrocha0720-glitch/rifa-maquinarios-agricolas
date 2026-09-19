const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const PRICE_CENTS = 35; // 35 centavos por cota
const MIN_QTY = 50;
const MAX_QTY = 100000;

// Cliente criado sob demanda: se as variáveis de ambiente faltarem, o erro
// acontece dentro do handler (resposta JSON legível) e não na carga do módulo,
// que derrubaria a função inteira com FUNCTION_INVOCATION_FAILED.
let supabaseClient = null;
function getSupabase() {
  if (!supabaseClient) {
    supabaseClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return supabaseClient;
}

function missingEnv() {
  return ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'BUCKPAY_TOKEN', 'BUCKPAY_USER_AGENT']
    .filter(function (name) { return !process.env[name]; });
}

function getBaseUrl() {
  // PUBLIC_BASE_URL é o domínio fixo de produção. VERCEL_URL é o host específico
  // do deployment — serve de fallback, mas com Deployment Protection ligada o
  // postback da BuckPay tomaria 401.
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const absent = missingEnv();
    if (absent.length) {
      console.error('create-charge: variáveis de ambiente ausentes:', absent.join(', '));
      return res.status(500).json({ error: 'Configuração do servidor incompleta' });
    }

    const baseUrl = getBaseUrl();
    if (!baseUrl) {
      console.error('create-charge: defina PUBLIC_BASE_URL com o domínio de produção');
      return res.status(500).json({ error: 'Configuração do servidor incompleta' });
    }

    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const phoneClean = String(body.phone == null ? '' : body.phone).replace(/\D/g, '');
    const qty = Number(body.qty);

    if (!name || !phoneClean || !body.qty) {
      return res.status(400).json({ error: 'Nome, telefone e quantidade são obrigatórios' });
    }

    if (!Number.isInteger(qty)) {
      return res.status(400).json({ error: 'Quantidade inválida' });
    }

    if (qty < MIN_QTY) {
      return res.status(400).json({ error: `Mínimo de ${MIN_QTY} cotas (R$ 17,50)` });
    }

    if (qty > MAX_QTY) {
      return res.status(400).json({ error: `Máximo de ${MAX_QTY} cotas por compra` });
    }

    const supabase = getSupabase();
    const amount = qty * PRICE_CENTS;

    // Busca ou cria usuário
    let { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phoneClean)
      .maybeSingle();

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

    // Cria cobrança na BuckPay.
    // postback_url e postbackUrl vão juntos porque a documentação da BuckPay não
    // é pública e os demais campos são snake_case: se o nome estiver errado, o
    // webhook nunca dispara e a compra fica presa em "pending" para sempre.
    // Confirmar com o suporte e remover a chave que não for usada.
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
        postback_url: `${baseUrl}/api/webhook`,
        postbackUrl: `${baseUrl}/api/webhook`
      })
    });

    const raw = await buckpayRes.text();
    let buckpayData;
    try {
      buckpayData = JSON.parse(raw);
    } catch (e) {
      console.error('create-charge: resposta não-JSON da BuckPay:', buckpayRes.status, raw.slice(0, 500));
      return res.status(502).json({ error: 'Falha ao gerar a cobrança PIX' });
    }

    if (!buckpayRes.ok) {
      console.error('create-charge: BuckPay retornou', buckpayRes.status, raw.slice(0, 500));
      return res.status(502).json({ error: buckpayData.message || 'Falha ao gerar a cobrança PIX' });
    }

    const pixCode = buckpayData.pix && buckpayData.pix.code;
    if (!pixCode) {
      console.error('create-charge: resposta da BuckPay sem pix.code:', raw.slice(0, 500));
      return res.status(502).json({ error: 'Falha ao gerar a cobrança PIX' });
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
      pix_code: pixCode,
      qrcode_base64: buckpayData.pix && buckpayData.pix.qrcode_base64,
      transaction_id: buckpayData.id,
      total: (amount / 100).toFixed(2)
    });

  } catch (err) {
    console.error('create-charge error:', err);
    return res.status(500).json({ error: 'Erro ao processar a compra' });
  }
};
