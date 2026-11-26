export const COMPANY_PLANS = [
  {
    id: "start",
    nome: "Plano Start",
    tag: "Essencial",
    subtitulo: "Ideal para pequenas lojas e MEIs",
    valor: 50,
    destaque: false,
    corBadge: "bg-neutral-800 text-neutral-200 border-brand-border",
    corBorda: "border-brand-border hover:border-brand-yellow/60",
    icone: "fa-rocket",
    beneficios: [
      "Portal da Empresa exclusivo com Login + CNPJ",
      "Até 2 solicitações de requisitos de vaga por mês",
      "Entrevistas feitas pela equipe JP RH com IA Pedrox",
      "Relatório de avaliação completo (nota 0–10 + parecer)",
      "Acesso ao Banco de Talentos avaliados da JP RH"
    ]
  },
  {
    id: "impulso",
    nome: "Plano Impulso",
    tag: "Mais Vendido",
    subtitulo: "Contratação ágil para empresas em expansão",
    valor: 149,
    destaque: true,
    corBadge: "bg-brand-yellow/20 text-brand-yellow border-brand-yellow/40",
    corBorda: "border-brand-yellow/60 hover:border-brand-yellow",
    icone: "fa-bolt",
    beneficios: [
      "Tudo do Plano Start incluso",
      "Solicitações ILIMITADAS de requisitos de vagas no mês",
      "Triagem prioritária em até 48h com equipe JP RH + Pedrox",
      "Comparativo de até 3 finalistas avaliados por vaga aberta",
      "Suporte direto de RH via WhatsApp em horário comercial"
    ]
  },
  {
    id: "lider",
    nome: "Plano Líder",
    tag: "Alta Performance",
    subtitulo: "Equipe treinada, organizada e com baixo turnover",
    valor: 269,
    destaque: false,
    corBadge: "bg-sky-500/20 text-sky-300 border-sky-500/40",
    corBorda: "border-sky-500/40 hover:border-sky-400",
    icone: "fa-chart-line",
    beneficios: [
      "Tudo do Plano Impulso incluso",
      "1 Treinamento/Workshop mensal de vendas e atendimento",
      "Acesso completo ao Banco de Talentos + vagas em destaque",
      "Diagnóstico mensal de clima organizacional e retenção",
      "Reunião mensal de alinhamento estratégico de RH"
    ]
  },
  {
    id: "vip",
    nome: "Plano VIP 360°",
    tag: "Exclusivo VIP",
    subtitulo: "Consultoria + Formação de Líderes & Gerentes",
    valor: 400,
    destaque: true,
    corBadge: "bg-amber-500/25 text-brand-yellow border-brand-yellow",
    corBorda: "border-2 border-brand-yellow shadow-xl shadow-brand-yellow/10",
    icone: "fa-crown",
    beneficios: [
      "Tudo do Plano Líder incluso",
      "Consultoria empresarial direta com João Pedro & JP RH",
      "Formação de Líderes e Gerentes para sua equipe",
      "Banco de Talentos VIP + busca ativa (Headhunting local)",
      "Estruturação de cargos, escalas, metas e acompanhamento quinzenal"
    ]
  }
];

export const DEFAULT_PLAN_PRICES = {
  start: 50,
  impulso: 149,
  lider: 269,
  vip: 400,
  candVip: 20
};

export function applyDynamicPlanPrices(cfg = {}) {
  const map = {
    start: Number(cfg.valorStart),
    impulso: Number(cfg.valorImpulso),
    lider: Number(cfg.valorLider),
    vip: Number(cfg.valorVip)
  };
  COMPANY_PLANS.forEach((p) => {
    const val = map[p.id];
    p.valor = Number.isFinite(val) && val > 0 ? Math.round(val * 100) / 100 : DEFAULT_PLAN_PRICES[p.id];
  });
}

export function getCandidateVipPrice(cfg = {}) {
  const val = Number(cfg.valorCandVip);
  return Number.isFinite(val) && val > 0 ? Math.round(val * 100) / 100 : DEFAULT_PLAN_PRICES.candVip;
}

export function getPlanById(id) {
  return COMPANY_PLANS.find((p) => p.id === id) || COMPANY_PLANS[0];
}
