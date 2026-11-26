import { ai, getGenerativeModel } from "./firebase-init.js";

const PEDROX_MODELS = ["gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.5-flash-lite"];

function parseJsonSafe(rawText) {
  if (!rawText) return null;
  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

async function callPedroxGemini(prompt) {
  if (!ai) throw new Error("AI_NOT_INITIALIZED");
  let lastError = null;
  for (const modelName of PEDROX_MODELS) {
    try {
      const model = getGenerativeModel(ai, {
        model: modelName,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2400,
          responseMimeType: "application/json"
        }
      });
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const parsed = parseJsonSafe(text);
      if (parsed) return { data: parsed, modelUsed: modelName, usedAI: true };
    } catch (err) {
      lastError = err;
      console.warn(`[Pedrox] Modelo ${modelName} indisponível:`, err?.message || err);
    }
  }
  throw lastError || new Error("AI_CALL_FAILED");
}

function buildLocalQuestions(cargo, requisitosList, candidato) {
  const reqs = requisitosList.length
    ? requisitosList
    : ["Proatividade", "Experiência em atendimento", "Comprometimento e trabalho em equipe"];

  const templates = [
    {
      match: /proativ|iniciativa|autonom|dinamic|agil/i,
      tipo: "Comportamental",
      build: (req) => ({
        criterio: req,
        pergunta: `Conte uma situação real em que você percebeu um problema ou oportunidade no trabalho e agiu por conta própria antes que alguém pedisse. Qual foi o resultado?`,
        objetivo: "Avaliar iniciativa prática, senso de dono e capacidade de resolver problemas sem supervisão constante.",
        oQueObservar: "Exemplos concretos com ação clara e resultado mensurável; evitar respostas genéricas."
      })
    },
    {
      match: /atend|client|recep|p[uú]blico|simpat|comunica/i,
      tipo: "Situacional",
      build: (req) => ({
        criterio: req,
        pergunta: `Imagine um cliente insatisfeito ou impaciente durante um horário de pico para a função de ${cargo}. Passo a passo, como você conduziria esse atendimento?`,
        objetivo: "Medir empatia, controle emocional, clareza na comunicação e capacidade de reverter situações difíceis.",
        oQueObservar: "Escuta ativa, tom respeitoso, foco em solução prática e postura profissional sob pressão."
      })
    },
    {
      match: /venda|meta|comerci|negocia|fechament|persuas/i,
      tipo: "Técnica",
      build: (req) => ({
        criterio: req,
        pergunta: `Quando um cliente diz "só estou olhando" ou acha o preço alto, qual abordagem você usa para gerar valor e conduzir para o fechamento da venda?`,
        objetivo: "Avaliar técnica de vendas consultivas, quebra de objeções e orientação para metas.",
        oQueObservar: "Perguntas de sondagem, foco em benefício e acompanhamento pós-atendimento."
      })
    },
    {
      match: /lider|geren|gest[aã]o|equipe|supervis|encarreg/i,
      tipo: "Comportamental",
      build: (req) => ({
        criterio: req,
        pergunta: `Descreva como você lida com um colaborador desmotivado ou que não está batendo metas. Como você dá feedback e acompanha a evolução?`,
        objetivo: "Verificar maturidade de liderança, comunicação assertiva e foco em desenvolvimento de pessoas.",
        oQueObservar: "Feedback em particular, clareza de expectativas, plano de ação e equilíbrio entre cobrança e apoio."
      })
    },
    {
      match: /excel|inform|comput|sistema|caixa|pdv|financ|nf|nota|admin/i,
      tipo: "Técnica",
      build: (req) => ({
        criterio: req,
        pergunta: `Quais rotinas, planilhas ou sistemas você já operou no dia a dia relacionados a "${req}" e como garante zero erros nos registros?`,
        objetivo: "Validar domínio técnico real, atenção a detalhes e organização de processos.",
        oQueObservar: "Segurança ao explicar ferramentas usadas, conferência de dados e rotina de controle."
      })
    },
    {
      match: /estoq|log[ií]st|confer|entrega|cnh|motorist|operac/i,
      tipo: "Técnica",
      build: (req) => ({
        criterio: req,
        pergunta: `Como você organiza sua rotina para garantir agilidade e evitar divergências ou atrasos em atividades ligadas a "${req}"?`,
        objetivo: "Avaliar disciplina operacional, organização, responsabilidade e cumprimento de prazos.",
        oQueObservar: "Método de checagem, cuidado com segurança/materiais e agilidade sem perder precisão."
      })
    }
  ];

  const perguntas = [];
  const usedIdx = new Set();

  reqs.slice(0, 6).forEach((req) => {
    const idx = templates.findIndex((t, i) => !usedIdx.has(i) && t.match.test(req));
    if (idx !== -1) {
      usedIdx.add(idx);
      perguntas.push({ tipo: templates[idx].tipo, ...templates[idx].build(req) });
    } else {
      perguntas.push({
        tipo: "Técnica / Situacional",
        criterio: req,
        pergunta: `A empresa busca alguém com "${req}" para atuar como ${cargo}. Dê um exemplo prático da sua trajetória que comprove essa competência no dia a dia.`,
        objetivo: `Validar na prática o domínio e a aderência do candidato ao requisito "${req}".`,
        oQueObservar: "Clareza na explicação, exemplo real e conexão direta com a rotina da vaga."
      });
    }
  });

  if (perguntas.length < 5) {
    perguntas.push({
      tipo: "Alinhamento & Cultura",
      criterio: "Aderência ao Cargo",
      pergunta: `O que mais te motiva na vaga de ${cargo} e o que a empresa pode esperar da sua entrega nos primeiros 90 dias?`,
      objetivo: "Entender motivação real, estabilidade esperada e alinhamento de expectativas.",
      oQueObservar: "Interesse genuíno em crescer, clareza de objetivos e compatibilidade com a rotina."
    });
  }

  return {
    resumoEstrategico: `Roteiro estruturado pelo Pedrox para avaliar aderência à vaga de ${cargo}, cobrindo os requisitos solicitados pela empresa (${reqs.join(", ")}).`,
    perguntas
  };
}

export async function pedroxGenerateQuestions({ cargo, empresaNome, requisitos, descricao, candidato }) {
  const reqList = Array.isArray(requisitos)
    ? requisitos.filter(Boolean)
    : String(requisitos || "").split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);

  const prompt = `Você é o PEDROX, a inteligência artificial oficial de Recrutamento e Seleção da agência JP RH (Eunápolis - BA).
Gere um roteiro de entrevista em português do Brasil para o entrevistador da JP RH aplicar ao candidato com base nos requisitos definidos pela empresa contratante.

Dados da vaga:
- Cargo: ${cargo || "Vaga Operacional / Comercial"}
- Empresa solicitante: ${empresaNome || "Empresa Parceira JP RH"}
- Requisitos: ${reqList.join(", ") || "Proatividade, atendimento, comprometimento"}
- Detalhes adicionais: ${descricao || "Não informado"}
- Candidato: ${candidato?.cargo || ""} | Exp: ${candidato?.experiencia || ""} | Habilidades: ${(candidato?.habilidades || []).join(", ")}

Gere de 5 a 7 perguntas práticas e específicas para CADA requisito. Retorne EXCLUSIVAMENTE JSON válido:
{
  "resumoEstrategico": "Orientação breve (2 frases) do Pedrox para o entrevistador.",
  "perguntas": [
    {
      "criterio": "Nome do requisito",
      "tipo": "Comportamental | Técnica | Situacional",
      "pergunta": "Pergunta pronta para o entrevistador fazer",
      "objetivo": "O que mede",
      "oQueObservar": "Sinais positivos e alertas na resposta"
    }
  ]
}`;

  try {
    const res = await callPedroxGemini(prompt);
    if (res.data && Array.isArray(res.data.perguntas) && res.data.perguntas.length > 0) {
      return {
        resumoEstrategico: res.data.resumoEstrategico || "Roteiro gerado por Pedrox (Gemini AI).",
        perguntas: res.data.perguntas,
        usedAI: true,
        modelUsed: res.modelUsed
      };
    }
  } catch (err) {
    console.info("[Pedrox] Motor local:", err?.message || err);
  }

  return { ...buildLocalQuestions(cargo || "Profissional", reqList, candidato), usedAI: false, modelUsed: "pedrox-motor-rh" };
}

export async function pedroxGenerateEvaluation({ cargo, empresaNome, requisitos, candidatoNomeProtegido, perguntasComRespostas, notaGeral }) {
  const itemsText = perguntasComRespostas
    .map((p, idx) => `${idx + 1}. Critério: ${p.criterio} | Nota: ${p.nota}/10 | Resposta: ${p.respostaResumo || "Sem anotação"}`)
    .join("\n");

  const prompt = `Você é o PEDROX, IA de avaliação de entrevistas da JP RH (Eunápolis - BA).
Analise a entrevista conduzida pela JP RH e elabore um parecer objetivo para a empresa contratante (SEM incluir telefone nem sobrenome completo).
Candidato: ${candidatoNomeProtegido} | Vaga: ${cargo} (${empresaNome || "Empresa Parceira"}) | Requisitos: ${(requisitos || []).join(", ")} | Média: ${notaGeral}/10
Respostas:\n${itemsText}
Retorne EXCLUSIVAMENTE JSON válido:
{
  "pontosFortes": "2 a 3 frases objetivas",
  "pontosAtencao": "1 a 2 frases objetivas",
  "parecerPedrox": "3 a 4 frases consolidadas recomendando ou não a contratação",
  "recomendacao": "Recomendado | Recomendado com Ressalvas | Não Recomendado"
}`;

  try {
    const res = await callPedroxGemini(prompt);
    if (res.data && res.data.parecerPedrox) {
      return {
        pontosFortes: res.data.pontosFortes || "",
        pontosAtencao: res.data.pontosAtencao || "",
        parecerPedrox: res.data.parecerPedrox || "",
        recomendacao: res.data.recomendacao || (notaGeral >= 7.5 ? "Recomendado" : notaGeral >= 5.5 ? "Recomendado com Ressalvas" : "Não Recomendado"),
        usedAI: true
      };
    }
  } catch (err) {
    console.info("[Pedrox] Parecer local:", err?.message || err);
  }

  const fortes = perguntasComRespostas.filter((p) => Number(p.nota) >= 7.5).map((p) => p.criterio);
  const atencao = perguntasComRespostas.filter((p) => Number(p.nota) < 7).map((p) => p.criterio);
  const recomendacao = notaGeral >= 7.5 ? "Recomendado" : notaGeral >= 5.5 ? "Recomendado com Ressalvas" : "Não Recomendado";

  return {
    pontosFortes: fortes.length
      ? `Destaque nos critérios de ${fortes.join(", ")}, demonstrando ótima aderência à vaga de ${cargo}.`
      : `Boa postura e interesse demonstrados na entrevista conduzida pela JP RH para ${cargo}.`,
    pontosAtencao: atencao.length
      ? `Recomenda-se acompanhamento inicial em ${atencao.join(", ")}.`
      : "Sem pontos críticos impeditivos; recomenda-se alinhamento padrão de metas nos primeiros 30 dias.",
    parecerPedrox: `Com média ${notaGeral.toFixed(1)}/10 na entrevista estruturada JP RH + Pedrox, ${candidatoNomeProtegido} recebeu classificação "${recomendacao}" para ${cargo}.`,
    recomendacao,
    usedAI: false
  };
}

// ============================================================================
// PEDROX SUPORTE AO CLIENTE ASSINANTE (TIRA DÚVIDAS DO SITE + DIRECIONA P/ HUMANO)
// ============================================================================
export async function pedroxSupportReply({ message, history = [], companyName, planName }) {
  const lower = String(message || "").toLowerCase();

  // Explicit human handoff triggers
  const wantsHuman = /(falar com (um )?(vendedor|atendente|humano|funcionario|funcionário|pessoa|alguem|alguém|joao|joão)|chamar (um )?(vendedor|atendente|humano)|cancelar|reclama|estorno|nota fiscal|desconto|negociar|nao consegui|não consegui|preciso de ajuda humana)/i.test(lower);

  if (wantsHuman) {
    return {
      resposta: `Perfeito! Já sinalizei aqui para um vendedor/consultor da equipe JP RH assumir o seu atendimento agora mesmo neste chat. Enquanto isso, se quiser adiantar mais algum detalhe, pode mandar por aqui!`,
      encaminharHumano: true,
      usedAI: false
    };
  }

  const historyText = history
    .slice(-6)
    .map((m) => `${m.autorTipo === "empresa" ? "Empresa" : m.autorTipo === "pedrox" ? "Pedrox" : "Vendedor JP RH"}: ${m.texto}`)
    .join("\n");

  const prompt = `Você é o PEDROX, assistente virtual oficial da JP RH (Eunápolis - BA) no chat de suporte para empresas assinantes.
Empresa atendida: ${companyName || "Empresa Parceira"} | Plano atual: ${planName || "Plano Ativo"}

Como o site da JP RH funciona (use isso para ensinar o cliente passo a passo):
1. Aba "Requisitos da Vaga": a empresa informa cargo, área, regime, salário e adiciona os requisitos desejados (ex.: Proativo, Experiência em atendimento). Ao enviar, a equipe JP RH recebe na hora.
2. Entrevistas: empresas não entrevistam diretamente no site; os analistas da JP RH usam a IA Pedrox para entrevistar e pontuar os candidatos de 0 a 10.
3. Aba "Avaliações JP RH": mostra todos os candidatos entrevistados com nota geral, pontos fortes, pontos de atenção, parecer Pedrox e botão "Avançar Contratação com a JP RH".
4. Planos JP RH:
   - Plano Start (R$ 50/mês): até 2 vagas/mês, entrevistas Pedrox, relatórios e Banco de Talentos avaliados.
   - Plano Impulso (R$ 149/mês): vagas ilimitadas, triagem prioritária 48h, comparativo de até 3 finalistas, suporte WhatsApp.
   - Plano Líder (R$ 269/mês): tudo do Impulso + 1 treinamento mensal de vendas/atendimento + diagnóstico de clima/turnover + reunião mensal.
   - Plano VIP 360° (R$ 400/mês): tudo do Líder + consultoria empresarial com João Pedro + formação de líderes e gerentes + Banco de Talentos VIP com headhunting.
5. Pagamento & Renovação: na aba "Meu Plano" há QR Code Pix automático (Copia e Cola) com valor exato e opção de cartão (se ativado), além do botão "Já fiz o Pix".
6. Trocar senha: botão "Trocar Senha" no topo do Portal da Empresa (envia link oficial por e-mail ou protocolo no WhatsApp).

Histórico recente:\n${historyText || "(Início do atendimento)"}
Nova mensagem da empresa: "${message}"

Se você conseguir resolver ensinando como mexer no site ou explicando os planos, responda de forma simpática, objetiva (máx. 4 linhas) e defina encaminharHumano=false.
Se a dúvida exigir intervenção humana (negociação, cobrança específica, urgência comercial, problema técnico que você não resolve ou pedido explícito), responda avisando que está direcionando para um vendedor da JP RH e defina encaminharHumano=true.

Retorne EXCLUSIVAMENTE JSON válido:
{
  "resposta": "Sua resposta clara em português do Brasil",
  "encaminharHumano": false
}`;

  try {
    const res = await callPedroxGemini(prompt);
    if (res.data && res.data.resposta) {
      return {
        resposta: res.data.resposta,
        encaminharHumano: Boolean(res.data.encaminharHumano),
        usedAI: true
      };
    }
  } catch (err) {
    console.info("[Pedrox Support] Usando base inteligente local:", err?.message || err);
  }

  // Smart local helpdesk fallback
  if (/requisit|vaga|abrir|solicitar|cadastrar vaga/i.test(lower)) {
    return {
      resposta: `Para solicitar candidatos, clique na aba "Requisitos da Vaga" aqui em cima, preencha o cargo e adicione as características que você precisa (ex.: Proativo, Experiência em atendimento). Depois clique em "Enviar Requisitos" que a equipe JP RH já entra em ação!`,
      encaminharHumano: false,
      usedAI: false
    };
  }
  if (/avaliac|avaliaç|candidat|curric|curríc|entrevist|nota/i.test(lower)) {
    return {
      resposta: `Na aba "Avaliações JP RH" você acompanha todos os candidatos já entrevistados pela nossa equipe com nota de 0 a 10, pontos fortes e parecer completo. Quando gostar de um perfil, clique em "Avançar Contratação com a JP RH"!`,
      encaminharHumano: false,
      usedAI: false
    };
  }
  if (/plano|upgrade|vip|lider|líder|impulso|start|pagar|pix|renov|cartao|cartão/i.test(lower)) {
    return {
      resposta: `Na aba "Meu Plano" você pode consultar sua validade ou escolher um upgrade entre Start (R$ 50), Impulso (R$ 149), Líder (R$ 269) e VIP 360° (R$ 400 — com consultoria e formação de líderes). Lá já geramos o QR Code Pix na hora! Quer que eu chame um vendedor para te ajudar no upgrade?`,
      encaminharHumano: false,
      usedAI: false
    };
  }
  if (/senha|login|acesso|email|e-mail/i.test(lower)) {
    return {
      resposta: `Para alterar sua senha, clique no botão "Trocar Senha" no canto superior direito aqui do Portal da Empresa. Você pode escolher receber o link oficial no seu e-mail ou gerar um código de protocolo para o WhatsApp!`,
      encaminharHumano: false,
      usedAI: false
    };
  }

  return {
    resposta: `Entendi sua dúvida! Para te dar um suporte ainda mais preciso sobre isso, já encaminhei esta conversa para um vendedor/consultor da equipe JP RH responder você aqui mesmo. Se preferir, também pode me perguntar sobre "como enviar requisitos", "ver avaliações" ou "planos".`,
    encaminharHumano: true,
    usedAI: false
  };
}
