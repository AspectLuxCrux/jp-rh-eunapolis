import {
  ADMIN_EMAIL,
  WHATSAPP_JPRH,
  getPasswordResetActionSettings,
  auth,
  db,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  confirmPasswordReset,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where
} from "./firebase-init.js";
import { COMPANY_PLANS, getPlanById } from "./plans.js";
import { generatePixPayload, getPixQrImageUrl } from "./pix-brcode.js";
import { pedroxGenerateQuestions, pedroxGenerateEvaluation, pedroxSupportReply } from "./pedrox.js";

// ============================================================================
// STATE
// ============================================================================
const state = {
  user: null,
  role: "visitor", // 'visitor' | 'company' | 'staff' | 'admin'
  companyProfile: null,
  staffProfile: null,
  selectedPlanId: "start",
  pixConfig: {
    chavePix: "(73) 98144-3993",
    titularPix: "João Pedro Morais da Silva Leite",
    bancoPix: "JP RH Eunápolis",
    valorPremium: 50,
    whatsappFinanceiro: WHATSAPP_JPRH,
    linkCartaoCandVip: "",
    linkCartaoStart: "",
    linkCartaoImpulso: "",
    linkCartaoLider: "",
    linkCartaoVip: ""
  },
  talents: [],
  equipeVitrine: [],
  empresasContratando: [],
  privateContacts: new Map(),
  empresas: [],
  funcionarios: [],
  solicitacoes: [],
  avaliacoes: [],
  avaliacoesEmpresa: [],
  avaliacoesGerais: [],
  financeiro: [],
  vendasEquipe: [],
  // Support Chat
  suporteChats: [],
  activeSupportChatId: null,
  activeSupportMessages: [],
  activeSupportMsgUnsub: null,
  companySupportChat: null,
  companySupportMessages: [],
  // Candidate VIP R$ 20
  pendingCandidateVip: null, // { id, codigo, nomeProtegido }
  vipUnlockedCode: null,
  regularidadeFilter: "todos",
  pedrox: {
    perguntas: [],
    resumoEstrategico: "",
    usedAI: false,
    modelUsed: ""
  },
  companyReqsDraft: [],
  securityCode: { code: null, expiresAt: 0, channel: null },
  staffPhotoDraft: "",
  vitrinePhotoDraft: "",
  unsubs: []
};

// ============================================================================
// UTILITIES
// ============================================================================
function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isDirectorRole() {
  return state.role === "admin" || (state.role === "staff" && state.staffProfile?.nivel === "diretor");
}

function getProtectedName(fullName) {
  if (!fullName) return "Candidato JP RH";
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1].charAt(0).toUpperCase()}.`;
}

function formatMoney(val) {
  return (Number(val) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("pt-BR");
}

function formatDateTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function formatCnpj(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 14);
  return digits
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2")
    .replace(/(\d{4})(\d)/, "$1-$2");
}

export function isValidCnpj(cnpj) {
  const digits = String(cnpj || "").replace(/\D/g, "");
  if (digits.length !== 14 || /^(\d)\1+$/.test(digits)) return false;
  const calc = (base, weights) => {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) sum += parseInt(base[i], 10) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return (
    calc(digits, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === parseInt(digits[12], 10) &&
    calc(digits, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === parseInt(digits[13], 10)
  );
}

function isCompanyPremiumActive(company) {
  if (!company || company.plano !== "premium") return false;
  if (company.premiumAte && Number(company.premiumAte) < Date.now()) return false;
  return true;
}

function getCompanyRegularity(emp) {
  const now = Date.now();
  const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
  if (emp.plano === "pendente") {
    return { code: "pendente", label: "Pagamento Pendente", detail: "Pix aguardando confirmação", badge: "bg-amber-500/20 text-amber-300 border-amber-500/30" };
  }
  if (emp.plano === "premium") {
    if (!emp.premiumAte) {
      return emp.emTeste
        ? { code: "regular", label: "Teste Experimental", detail: "Período experimental ativo", badge: "bg-purple-500/20 text-purple-300 border-purple-500/40" }
        : { code: "regular", label: "Regular / Ativo", detail: "Sem vencimento definido", badge: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" };
    }
    const diff = Number(emp.premiumAte) - now;
    const days = Math.ceil(diff / (24 * 60 * 60 * 1000));
    if (diff < 0) {
      return emp.emTeste
        ? { code: "irregular", label: "Teste Expirado", detail: `Teste encerrado há ${Math.abs(days)} dia(s)`, badge: "bg-red-500/20 text-red-400 border-red-500/40" }
        : { code: "irregular", label: "Irregular / Vencido", detail: `Vencido há ${Math.abs(days)} dia(s)`, badge: "bg-red-500/20 text-red-400 border-red-500/40" };
    }
    if (emp.emTeste) {
      return { code: diff <= fiveDaysMs ? "vencendo" : "regular", label: "Teste Experimental", detail: `${days} dia(s) restante(s)`, badge: "bg-purple-500/20 text-purple-300 border-purple-500/40" };
    }
    if (diff <= fiveDaysMs) {
      return { code: "vencendo", label: "Vence em Breve", detail: `Vence em ${days} dia(s)`, badge: "bg-yellow-500/20 text-brand-yellow border-brand-yellow/40" };
    }
    return { code: "regular", label: "Regular / Ativo", detail: `${days} dias restantes`, badge: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" };
  }
  return { code: "sem_plano", label: "Sem Plano (Gratuito)", detail: "Cadastro sem assinatura ativa", badge: "bg-neutral-800 text-neutral-400 border-brand-border" };
}

function compressImageFile(file, maxSize = 320, quality = 0.78) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      reject(new Error("Selecione uma imagem válida (JPG, PNG ou WebP)."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Erro ao ler imagem."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Não foi possível processar a imagem."));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let w = img.width;
        let h = img.height;
        if (w > h && w > maxSize) {
          h = Math.round((h * maxSize) / w);
          w = maxSize;
        } else if (h >= w && h > maxSize) {
          w = Math.round((w * maxSize) / h);
          h = maxSize;
        }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve(dataUrl.length > 260000 ? canvas.toDataURL("image/jpeg", 0.55) : dataUrl);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function clearRoleListeners() {
  state.unsubs.forEach((fn) => {
    try { fn(); } catch (_) {}
  });
  state.unsubs = [];
  if (state.activeSupportMsgUnsub) {
    try { state.activeSupportMsgUnsub(); } catch (_) {}
    state.activeSupportMsgUnsub = null;
  }
  state.privateContacts.clear();
  state.empresas = [];
  state.funcionarios = [];
  state.solicitacoes = [];
  state.avaliacoes = [];
  state.avaliacoesEmpresa = [];
  state.avaliacoesGerais = [];
  state.financeiro = [];
  state.vendasEquipe = [];
  state.suporteChats = [];
  state.activeSupportChatId = null;
  state.activeSupportMessages = [];
  state.companySupportChat = null;
  state.companySupportMessages = [];
}

window.showToast = function (message, type = "success") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  const bgClass = type === "error" ? "bg-red-950 border-red-700 text-red-100" : type === "info" ? "bg-brand-card border-sky-500 text-white" : "bg-brand-card border-brand-yellow text-white";
  const iconClass = type === "error" ? "fa-circle-exclamation text-red-400" : type === "info" ? "fa-robot text-sky-400" : "fa-circle-check text-brand-yellow";
  toast.className = `toast-enter pointer-events-auto flex items-center gap-3 px-4 py-3.5 rounded-2xl border shadow-2xl ${bgClass}`;
  toast.innerHTML = `<i class="fa-solid ${iconClass} text-lg shrink-0"></i><p class="text-xs sm:text-sm font-medium leading-snug">${esc(message)}</p>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    toast.style.transition = "all 0.25s ease";
    setTimeout(() => toast.remove(), 250);
  }, 4500);
};

function mapAuthError(err) {
  const code = err?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "E-mail ou senha incorretos.";
  if (code.includes("email-already-in-use")) return "Este e-mail já possui conta cadastrada. Use a aba Entrar.";
  if (code.includes("weak-password")) return "A senha precisa ter pelo menos 6 caracteres.";
  if (code.includes("invalid-email")) return "Informe um endereço de e-mail válido.";
  if (code.includes("requires-recent-login")) return "Por segurança, saia e entre novamente antes de alterar sua senha.";
  if (code.includes("too-many-requests")) return "Muitas tentativas. Aguarde alguns instantes.";
  return err?.message || "Erro ao autenticar.";
}

function getCardLinkForPlan(planId) {
  const map = {
    cand_vip: state.pixConfig.linkCartaoCandVip,
    start: state.pixConfig.linkCartaoStart,
    impulso: state.pixConfig.linkCartaoImpulso,
    lider: state.pixConfig.linkCartaoLider,
    vip: state.pixConfig.linkCartaoVip
  };
  return (map[planId] || "").trim();
}

// ============================================================================
// OLHINHO DE SENHA & RECUPERAÇÃO/TROCA DE SENHA
// ============================================================================
window.togglePasswordVisibility = function (inputId, btnEl) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isHidden = input.type === "password";
  input.type = isHidden ? "text" : "password";
  const icon = btnEl?.querySelector("i");
  if (icon) {
    icon.classList.toggle("fa-eye", !isHidden);
    icon.classList.toggle("fa-eye-slash", isHidden);
  }
  btnEl?.setAttribute("aria-label", isHidden ? "Ocultar senha" : "Mostrar senha");
};

window.getResetPageUrl = function (prefillEmail = "") {
  const basePath = `${window.location.origin}${window.location.pathname.replace(/\/[^/]*$/, "")}`;
  const qs = prefillEmail ? `?email=${encodeURIComponent(prefillEmail)}` : "";
  return `${basePath}/redefinir-senha/${qs}`;
};

function extractOobCodeFromInput(rawInput) {
  const val = (rawInput || "").trim();
  if (!val) return "";
  try {
    if (val.includes("oobCode=")) {
      const parsed = new URL(val.startsWith("http") ? val : `https://dummy.local/?${val.replace(/^\?/, "")}`);
      return (parsed.searchParams.get("oobCode") || "").trim();
    }
  } catch {
    const match = val.match(/[?&]oobCode=([^&\s]+)/);
    if (match) return decodeURIComponent(match[1]).trim();
  }
  return val;
}

window.handleInlineSendResetCode = async function (e, scope) {
  e.preventDefault();
  const emailEl = document.getElementById(`${scope}-reset-email`);
  const btnEl = document.getElementById(`btn-${scope}-send-code`);
  const infoEl = document.getElementById(`${scope}-reset-sent-info`);
  const email = (emailEl?.value || "").trim().toLowerCase();
  if (!email) return;

  btnEl.disabled = true;
  btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Enviando código...`;
  try {
    await sendPasswordResetEmail(auth, email, getPasswordResetActionSettings());
    infoEl?.classList.remove("hidden");
    window.showToast(`Código/link de troca de senha enviado para ${email}! Confira também o Spam.`);
  } catch (err) {
    window.showToast(mapAuthError(err), "error");
  } finally {
    btnEl.disabled = false;
    btnEl.innerHTML = `<i class="fa-solid fa-paper-plane mr-1.5"></i>Enviar Código / Link no E-mail`;
  }
};

window.handleInlineConfirmReset = async function (e, scope) {
  e.preventDefault();
  const rawCode = document.getElementById(`${scope}-reset-code`)?.value || "";
  const code = extractOobCodeFromInput(rawCode);
  const newPass = document.getElementById(`${scope}-reset-newpass`)?.value || "";
  const confirmPass = document.getElementById(`${scope}-reset-confirmpass`)?.value || "";
  const btnEl = document.getElementById(`btn-${scope}-confirm-reset`);

  if (!code) return window.showToast("Cole o código ou link recebido no seu e-mail.", "error");
  if (newPass.length < 6) return window.showToast("A nova senha precisa ter pelo menos 6 caracteres.", "error");
  if (newPass !== confirmPass) return window.showToast("As duas senhas precisam ser iguais.", "error");

  btnEl.disabled = true;
  btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Confirmando nova senha...`;
  try {
    const accountEmail = await verifyPasswordResetCode(auth, code);
    await confirmPasswordReset(auth, code, newPass);
    document.getElementById(`${scope}-reset-code`).value = "";
    document.getElementById(`${scope}-reset-newpass`).value = "";
    document.getElementById(`${scope}-reset-confirmpass`).value = "";
    window.showToast(`Senha atualizada com sucesso para ${accountEmail}! Agora é só entrar.`);
    if (scope === "comp") {
      const loginIn = document.getElementById("comp-login-email");
      if (loginIn) loginIn.value = accountEmail;
      window.switchCompanyAuthMode("login");
    } else {
      const loginIn = document.getElementById("admin-email-input");
      if (loginIn) loginIn.value = accountEmail;
      window.switchTeamAuthMode("login");
    }
  } catch (err) {
    const c = err?.code || "";
    if (c.includes("expired-action-code") || c.includes("invalid-action-code")) {
      window.showToast("Código inválido ou expirado. Clique no Passo 1 para receber um novo código.", "error");
    } else {
      window.showToast(mapAuthError(err), "error");
    }
  } finally {
    btnEl.disabled = false;
    btnEl.innerHTML = `<i class="fa-solid fa-key mr-1.5"></i>Confirmar e Trocar Senha Agora`;
  }
};

window.copyPasswordResetLink = async function (prefillEmail = "") {
  const url = window.getResetPageUrl(prefillEmail);
  try {
    await navigator.clipboard.writeText(url);
    window.showToast("Link da página de troca de senha copiado!");
  } catch {
    window.showToast(`Link de troca de senha: ${url}`, "info");
  }
};

window.openPasswordResetModal = function (prefillEmail = "") {
  const modal = document.getElementById("modal-password-reset");
  if (!modal) return;
  const emailIn = document.getElementById("reset-email-input");
  const resolvedEmail = prefillEmail || state.user?.email || "";
  if (emailIn && resolvedEmail) emailIn.value = resolvedEmail;
  const directLink = document.getElementById("modal-reset-page-link");
  if (directLink) directLink.href = window.getResetPageUrl(resolvedEmail);
  window.switchResetMethod("email");
  document.getElementById("reset-phone-result")?.classList.add("hidden");
  modal.classList.remove("hidden");
};
window.closePasswordResetModal = function () {
  document.getElementById("modal-password-reset")?.classList.add("hidden");
};
window.switchResetMethod = function (method) {
  const btnEmail = document.getElementById("reset-tab-email");
  const btnPhone = document.getElementById("reset-tab-phone");
  const paneEmail = document.getElementById("reset-pane-email");
  const panePhone = document.getElementById("reset-pane-phone");
  if (!btnEmail || !btnPhone) return;
  if (method === "email") {
    btnEmail.className = "py-2.5 px-3 rounded-xl font-bold text-xs sm:text-sm bg-brand-yellow text-brand-black";
    btnPhone.className = "py-2.5 px-3 rounded-xl font-bold text-xs sm:text-sm text-neutral-400 hover:text-white";
    paneEmail.classList.remove("hidden");
    panePhone.classList.add("hidden");
  } else {
    btnPhone.className = "py-2.5 px-3 rounded-xl font-bold text-xs sm:text-sm bg-brand-yellow text-brand-black";
    btnEmail.className = "py-2.5 px-3 rounded-xl font-bold text-xs sm:text-sm text-neutral-400 hover:text-white";
    panePhone.classList.remove("hidden");
    paneEmail.classList.add("hidden");
  }
};

window.handleSendPasswordResetEmail = async function (e) {
  e.preventDefault();
  const email = document.getElementById("reset-email-input").value.trim().toLowerCase();
  if (!email) return;
  const btn = document.getElementById("btn-reset-email");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Enviando link...`;
  try {
    await sendPasswordResetEmail(auth, email, getPasswordResetActionSettings());
    window.showToast(`Link oficial de troca de senha enviado para ${email}! Confira também o Spam.`);
    window.closePasswordResetModal();
  } catch (err) {
    window.showToast(mapAuthError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-envelope mr-2"></i>Enviar Link de Troca de Senha por E-mail`;
  }
};

window.handleSendPasswordResetPhone = function (e) {
  e.preventDefault();
  const email = document.getElementById("reset-phone-email").value.trim().toLowerCase();
  const phone = document.getElementById("reset-phone-number").value.trim();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  document.getElementById("reset-phone-code-display").textContent = code;
  const msg = `Olá *Suporte JP RH*! Solicito troca de senha:\n\n*E-mail:* ${email}\n*Telefone:* ${phone}\n*Código de Verificação:* ${code}`;
  document.getElementById("reset-phone-wa-link").href = `https://wa.me/${WHATSAPP_JPRH}?text=${encodeURIComponent(msg)}`;
  document.getElementById("reset-phone-result").classList.remove("hidden");
  window.showToast(`Código ${code} gerado!`, "info");
};

window.handleSendSecurityCode = async function (channel) {
  if (!state.user) return;
  if (channel === "email-link") {
    try {
      await sendPasswordResetEmail(auth, state.user.email, getPasswordResetActionSettings());
      window.showToast(`Link oficial enviado para ${state.user.email}! Confira também o Spam.`);
    } catch (err) {
      window.showToast(mapAuthError(err), "error");
    }
    return;
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  state.securityCode = { code, expiresAt: Date.now() + 10 * 60 * 1000, channel };
  const phoneInput = document.getElementById("sec-verify-phone")?.value.trim() || state.staffProfile?.telefone || "";
  const cleanPhone = phoneInput.replace(/\D/g, "");
  document.getElementById("sec-code-confirm-box")?.classList.remove("hidden");
  const hint = document.getElementById("sec-code-hint");

  if (channel === "whatsapp") {
    const target = cleanPhone ? (cleanPhone.startsWith("55") ? cleanPhone : `55${cleanPhone}`) : WHATSAPP_JPRH;
    const msg = `Código de segurança JP RH (${state.user.email}): *${code}* (válido por 10 min).`;
    window.open(`https://wa.me/${target}?text=${encodeURIComponent(msg)}`, "_blank", "noopener,noreferrer");
    if (hint) hint.innerHTML = `Código preparado para WhatsApp (<strong class="text-brand-yellow">${esc(phoneInput || "JP RH")}</strong>). Digite os 6 dígitos abaixo antes de salvar.`;
    window.showToast("Código de 6 dígitos preparado no WhatsApp!", "info");
  } else {
    if (hint) hint.innerHTML = `Código de confirmação para <strong class="text-brand-yellow">${esc(state.user.email)}</strong>: <code class="text-white font-bold px-2 py-0.5 rounded bg-brand-card">${code}</code>.`;
    window.showToast("Código de confirmação gerado.", "info");
  }
};

window.handleLoggedInChangePassword = async function (e) {
  e.preventDefault();
  if (!state.user) return;
  const currentPass = document.getElementById("sec-current-pass").value;
  const newPass = document.getElementById("sec-new-pass").value;
  const confirmPass = document.getElementById("sec-confirm-pass").value;
  const codeInput = (document.getElementById("sec-code-input")?.value || "").trim();

  if (newPass.length < 6) return window.showToast("A nova senha precisa ter no mínimo 6 caracteres.", "error");
  if (newPass !== confirmPass) return window.showToast("A confirmação da nova senha não confere.", "error");
  if (state.securityCode.code) {
    if (Date.now() > state.securityCode.expiresAt) return window.showToast("Código expirado. Gere outro.", "error");
    if (codeInput !== state.securityCode.code) return window.showToast("Código de 6 dígitos incorreto.", "error");
  }

  const btn = document.getElementById("btn-sec-change-pass");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Atualizando...`;
  try {
    await reauthenticateWithCredential(state.user, EmailAuthProvider.credential(state.user.email, currentPass));
    await updatePassword(state.user, newPass);
    if (state.role === "staff" && state.user.email) {
      try { await updateDoc(doc(db, "funcionarios", state.user.email.toLowerCase()), { exigirTrocaSenha: false }); } catch (_) {}
      document.getElementById("team-force-pass-banner")?.classList.add("hidden");
    } else if (state.role === "company" && state.user.uid) {
      try { await updateDoc(doc(db, "empresas", state.user.uid), { exigirTrocaSenha: false, updatedAt: Date.now() }); } catch (_) {}
      document.getElementById("comp-force-pass-banner")?.classList.add("hidden");
    }
    document.getElementById("form-sec-change-pass").reset();
    state.securityCode = { code: null, expiresAt: 0, channel: null };
    document.getElementById("sec-code-confirm-box")?.classList.add("hidden");
    window.showToast("Senha atualizada com sucesso!");
  } catch (err) {
    window.showToast(mapAuthError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-key mr-2"></i>Atualizar Minha Senha Agora`;
  }
};

// ============================================================================
// PUBLIC PLANS & TEAM VITRINE & HIRING COMPANIES (CANDIDATO VIP R$ 20)
// ============================================================================
function renderPublicPlansGrid() {
  const grid = document.getElementById("public-plans-grid");
  if (!grid) return;
  grid.innerHTML = COMPANY_PLANS.map((plan) => {
    const isVip = plan.id === "vip";
    const isImpulso = plan.id === "impulso";
    return `
      <div class="relative bg-brand-card ${plan.corBorda} rounded-3xl p-6 flex flex-col justify-between transition-all hover:-translate-y-1 ${isVip ? "bg-gradient-to-b from-brand-card to-brand-black" : ""}">
        <div>
          <div class="flex items-center justify-between gap-2 mb-4">
            <div class="w-11 h-11 rounded-2xl ${isVip || isImpulso ? "bg-brand-yellow text-brand-black" : "bg-brand-yellow/10 border border-brand-yellow/30 text-brand-yellow"} flex items-center justify-center text-lg">
              <i class="fa-solid ${plan.icone}"></i>
            </div>
            <span class="text-[10px] font-extrabold uppercase tracking-wider px-2.5 py-1 rounded-full border ${plan.corBadge}">${esc(plan.tag)}</span>
          </div>
          <h3 class="font-display font-extrabold text-xl text-white">${esc(plan.nome)}</h3>
          <p class="text-xs text-neutral-400 mt-1 min-h-[32px]">${esc(plan.subtitulo)}</p>
          <div class="my-5 pb-5 border-b border-brand-border flex items-baseline gap-1">
            <span class="text-sm font-bold text-neutral-400">R$</span>
            <span class="font-display font-extrabold text-4xl text-white">${plan.valor}</span>
            <span class="text-xs text-neutral-400">/mês</span>
          </div>
          <ul class="space-y-2.5 text-xs text-neutral-300 mb-6">
            ${plan.beneficios.map((b) => `<li class="flex items-start gap-2"><i class="fa-solid fa-circle-check text-brand-yellow mt-0.5 shrink-0"></i><span>${esc(b)}</span></li>`).join("")}
          </ul>
        </div>
        <button type="button" onclick="selectPlanAndOpenCompany('${plan.id}')"
                class="w-full py-3.5 px-4 rounded-xl font-extrabold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all ${isVip || isImpulso ? "bg-brand-yellow hover:bg-brand-yellowHover text-brand-black shadow-lg shadow-brand-yellow/15" : "bg-brand-black hover:bg-brand-yellow text-white hover:text-brand-black border border-brand-border hover:border-brand-yellow"}">
          <span>Assinar ${esc(plan.nome)}</span><i class="fa-solid fa-arrow-right text-xs"></i>
        </button>
      </div>`;
  }).join("");
}

window.selectPlanAndOpenCompany = function (planId) {
  state.selectedPlanId = planId;
  window.openCompanyModal("plano");
};

function renderPublicTeamVitrine() {
  const grid = document.getElementById("public-team-grid");
  const emptyBox = document.getElementById("public-team-empty");
  if (!grid) return;
  const activeMembers = state.equipeVitrine
    .filter((m) => m.ativo !== false)
    .sort((a, b) => (a.ordem ?? 50) - (b.ordem ?? 50) || (a.createdAt || 0) - (b.createdAt || 0));

  if (!activeMembers.length) {
    grid.innerHTML = "";
    emptyBox?.classList.remove("hidden");
    return;
  }
  emptyBox?.classList.add("hidden");
  grid.innerHTML = activeMembers
    .map((m) => {
      const initials = (m.nome || "JP").split(/\s+/).slice(0, 2).map((s) => s[0]).join("").toUpperCase();
      return `
        <div class="bg-brand-card border ${m.destaque ? "border-brand-yellow/60" : "border-brand-border"} hover:border-brand-yellow rounded-3xl p-6 text-center flex flex-col items-center transition-all hover:-translate-y-1 shadow-xl">
          <div class="relative mb-4">
            ${m.fotoUrl ? `<img src="${esc(m.fotoUrl)}" alt="${esc(m.nome)}" class="w-28 h-28 rounded-2xl object-cover border-2 border-brand-yellow/60 shadow-lg">` : `<div class="w-28 h-28 rounded-2xl bg-brand-black border-2 border-brand-yellow/40 flex items-center justify-center font-display font-extrabold text-3xl text-brand-yellow">${esc(initials)}</div>`}
            ${m.destaque ? `<span class="absolute -bottom-2 left-1/2 -translate-x-1/2 text-[10px] font-extrabold uppercase px-2.5 py-0.5 rounded-full bg-brand-yellow text-brand-black whitespace-nowrap shadow">Liderança JP RH</span>` : ""}
          </div>
          <h3 class="font-display font-extrabold text-lg text-white mt-1">${esc(m.nome)}</h3>
          <p class="text-xs font-bold text-brand-yellow mt-0.5">${esc(m.cargo)}</p>
          ${m.bio ? `<p class="text-xs text-neutral-400 mt-3 leading-relaxed">${esc(m.bio)}</p>` : ""}
        </div>`;
    })
    .join("");
}

function renderHiringCompaniesSection() {
  const countEl = document.getElementById("hiring-companies-count");
  const listEl = document.getElementById("hiring-companies-list");
  if (!listEl) return;

  const activeJobs = state.empresasContratando.filter((e) => e.ativa !== false).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (countEl) countEl.textContent = `${activeJobs.length}`;

  const unlocked = Boolean(state.vipUnlockedCode) || state.role === "admin" || state.role === "staff";

  if (!activeJobs.length) {
    listEl.innerHTML = `<div class="text-center py-6 text-xs text-neutral-400 bg-brand-black/60 border border-brand-border rounded-2xl">Novas empresas contratando em Eunápolis são atualizadas aqui diariamente assim que abrem vagas pela JP RH!</div>`;
    return;
  }

  if (!unlocked) {
    listEl.innerHTML = activeJobs
      .slice(0, 4)
      .map(
        (job) => `
        <div class="bg-brand-black border border-brand-border rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3 relative overflow-hidden">
          <div>
            <span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-brand-yellow/15 text-brand-yellow">${esc(job.area)}</span>
            <h5 class="font-display font-bold text-white text-sm mt-1">${esc(job.tituloVaga)}</h5>
            <p class="text-xs text-neutral-500 mt-0.5 blur-[4px] select-none">Empresa Parceira Confidencial • ${esc(job.salario || "Salário compatível")}</p>
          </div>
          <button type="button" onclick="openCandidateVipModal()" class="px-3.5 py-2 rounded-xl bg-brand-yellow/15 border border-brand-yellow/40 text-brand-yellow hover:bg-brand-yellow hover:text-brand-black font-bold text-xs flex items-center gap-1.5">
            <i class="fa-solid fa-lock"></i><span>Desbloquear (VIP R$ 20)</span>
          </button>
        </div>`
      )
      .join("");
    return;
  }

  listEl.innerHTML = activeJobs
    .map(
      (job) => `
      <div class="bg-brand-black border border-emerald-500/40 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="flex items-center gap-2">
            <span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400">Contratando Agora</span>
            <span class="text-[10px] font-bold text-brand-yellow">${esc(job.area)}</span>
          </div>
          <h5 class="font-display font-bold text-white text-base mt-1">${esc(job.empresaNome)} — <span class="text-brand-yellow">${esc(job.tituloVaga)}</span></h5>
          <p class="text-xs text-neutral-300 mt-0.5">${esc(job.regime || "CLT")} • ${esc(job.salario || "A combinar")}</p>
          ${(job.requisitos || []).length ? `<p class="text-[11px] text-neutral-400 mt-1">Requisitos: ${job.requisitos.map(esc).join(", ")}</p>` : ""}
        </div>
        <a href="https://wa.me/${WHATSAPP_JPRH}?text=${encodeURIComponent(`Olá *JP RH*! Sou *Candidato Destaque VIP* (${state.vipUnlockedCode || "VIP"}) e tenho interesse na vaga de *${job.tituloVaga}* da empresa *${job.empresaNome}*!`)}"
           target="_blank" rel="noopener noreferrer"
           class="px-4 py-2.5 rounded-xl bg-brand-yellow hover:bg-brand-yellowHover text-brand-black font-extrabold text-xs flex items-center gap-1.5">
          <i class="fa-brands fa-whatsapp"></i><span>Prioridade nesta Vaga</span>
        </a>
      </div>`
    )
    .join("");
}

window.handleUnlockCandidateVipArea = function (e) {
  e.preventDefault();
  const code = (document.getElementById("vip-unlock-code-input")?.value || "").trim().toUpperCase();
  if (!code) return;
  const found = state.talents.find((c) => (c.codigo || "").toUpperCase() === code);
  if (!found) {
    return window.showToast("Código não encontrado. Cadastre seu currículo primeiro.", "error");
  }
  if (found.planoCandidato === "vip" || found.destaque === true) {
    state.vipUnlockedCode = code;
    renderHiringCompaniesSection();
    window.showToast(`Acesso Candidato VIP (${code}) liberado! Veja abaixo as empresas contratando agora.`);
  } else {
    state.pendingCandidateVip = { id: found.id, codigo: found.codigo, nomeProtegido: found.nomeProtegido };
    window.openCandidateVipModal();
    window.showToast(`O código ${code} ainda está no plano gratuito. Ative o Destaque VIP de R$ 20 abaixo!`, "info");
  }
};

// ============================================================================
// MODAL CANDIDATO DESTAQUE VIP (R$ 20 COM QR CODE PIX REAL + CARTÃO OPCIONAL)
// ============================================================================
window.openCandidateVipModal = function (candidateInfo = null) {
  if (candidateInfo) state.pendingCandidateVip = candidateInfo;
  const modal = document.getElementById("modal-candidate-vip");
  if (!modal) return;

  const codeIn = document.getElementById("cand-vip-code-input");
  if (codeIn && state.pendingCandidateVip?.codigo) {
    codeIn.value = state.pendingCandidateVip.codigo;
  }

  renderCandidateVipPixBox();
  modal.classList.remove("hidden");
};

window.closeCandidateVipModal = function () {
  document.getElementById("modal-candidate-vip")?.classList.add("hidden");
};

function renderCandidateVipPixBox() {
  const payload = generatePixPayload({
    chavePix: state.pixConfig.chavePix,
    titular: state.pixConfig.titularPix,
    valor: 20,
    txid: `JPRHVIP20`
  });
  const qrImg = document.getElementById("cand-vip-qr-img");
  const codeEl = document.getElementById("cand-vip-brcode");
  const cardBtn = document.getElementById("cand-vip-card-btn");

  if (qrImg) qrImg.src = getPixQrImageUrl(payload, 200);
  if (codeEl) codeEl.value = payload;

  const cardLink = getCardLinkForPlan("cand_vip");
  if (cardBtn) {
    if (cardLink) {
      cardBtn.href = cardLink;
      cardBtn.classList.remove("hidden");
    } else {
      cardBtn.classList.add("hidden");
    }
  }
}

window.copyPixPayloadById = function (inputId) {
  const val = document.getElementById(inputId)?.value || "";
  if (!val) return;
  navigator.clipboard?.writeText(val).then(
    () => window.showToast("Código Pix Copia e Cola copiado! Cole no app do seu banco (valor já preenchido)."),
    () => window.showToast("Selecione e copie o código Pix acima.")
  );
};

window.handleCandidateVipPixConfirm = async function (e) {
  e.preventDefault();
  const code = (document.getElementById("cand-vip-code-input")?.value || "").trim().toUpperCase();
  const found = state.talents.find((c) => (c.codigo || "").toUpperCase() === code) || state.pendingCandidateVip;

  if (!found || !found.id) {
    window.showToast("Informe um código de currículo válido (ex: JP-1234) ou cadastre seu currículo primeiro.", "error");
    return;
  }

  const btn = document.getElementById("btn-cand-vip-confirm");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Registrando Pix R$ 20...`;
  try {
    const now = Date.now();
    await addDoc(collection(db, "financeiro"), {
      tipo: "entrada",
      categoria: "Plano Candidato VIP",
      descricao: `Candidato Destaque VIP R$ 20 — ${found.nomeProtegido || "Candidato"} (${found.codigo || code})`,
      valor: 20,
      status: "pendente",
      empresaUid: "",
      empresaNome: "",
      empresaCnpj: "",
      candidatoId: found.id,
      candidatoCodigo: found.codigo || code,
      planoTier: "cand_vip",
      vendedorEmail: "",
      vendedorNome: "",
      metodo: "Pix",
      competencia: currentMonthKey(),
      createdAt: now,
      paidAt: null
    });

    const msg = `Olá *JP RH*! Acabei de fazer o Pix de *R$ 20,00* para ativar meu *Plano Candidato Destaque VIP*:\n\n*Código do Currículo:* ${found.codigo || code}\n*Nome:* ${found.nomeProtegido || ""}\n\n_(Enviando comprovante abaixo)_`;
    window.showToast("Aviso de Pix de R$ 20 enviado ao Financeiro JP RH! Assim que aprovado, seu currículo sobe para o topo VIP.");
    window.open(`https://wa.me/${WHATSAPP_JPRH}?text=${encodeURIComponent(msg)}`, "_blank", "noopener,noreferrer");
    window.closeCandidateVipModal();
  } catch (err) {
    console.error("Erro Pix Candidato VIP:", err);
    window.showToast("Erro ao registrar aviso do Pix. Tente novamente.", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-check-double mr-2"></i>Já fiz o Pix de R$ 20,00 — Ativar Meu Destaque VIP`;
  }
};

function populateCompanySellerDropdown() {
  const sel = document.getElementById("comp-plan-seller-select");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">— Atendimento direto pelo site —</option>`;
  state.equipeVitrine
    .filter((m) => m.ativo !== false)
    .forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.nome;
      opt.textContent = `${m.nome} (${m.cargo})`;
      sel.appendChild(opt);
    });
  if (prev) sel.value = prev;
}

// ============================================================================
// PUBLIC LISTENERS
// ============================================================================
function startPublicListeners() {
  onSnapshot(
    collection(db, "candidatos"),
    (snapshot) => {
      const list = [];
      snapshot.forEach((docSnap) => list.push({ id: docSnap.id, ...docSnap.data() }));
      list.sort((a, b) => {
        const aVip = a.planoCandidato === "vip" || a.destaque ? 1 : 0;
        const bVip = b.planoCandidato === "vip" || b.destaque ? 1 : 0;
        if (bVip !== aVip) return bVip - aVip;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      state.talents = list;
      document.getElementById("talents-loading")?.classList.add("hidden");
      const heroCount = document.getElementById("hero-talent-count");
      if (heroCount) heroCount.textContent = `${state.talents.length}`;
      window.renderTalents();
      if (state.role === "admin" || state.role === "staff") {
        renderAdminTalentsTable();
        populatePedroxSelectors();
      }
    },
    (error) => {
      console.error("Erro candidatos:", error);
      document.getElementById("talents-loading")?.classList.add("hidden");
      window.renderTalents();
    }
  );

  onSnapshot(collection(db, "equipe_vitrine"), (snapshot) => {
    state.equipeVitrine = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderPublicTeamVitrine();
    populateCompanySellerDropdown();
    if (state.role === "admin") renderAdminVitrineTable();
  });

  onSnapshot(collection(db, "empresas_contratando"), (snapshot) => {
    state.empresasContratando = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderHiringCompaniesSection();
  });

  onSnapshot(doc(db, "configuracoes", "financeiro"), (snap) => {
    if (snap.exists()) state.pixConfig = { ...state.pixConfig, ...snap.data() };
    renderPixConfigUI();
    renderCandidateVipPixBox();
    if (state.role === "company") renderCompanyDashboard();
  });
}

// ============================================================================
// AUTHENTICATION & ROLE SUBSCRIPTIONS
// ============================================================================
onAuthStateChanged(auth, async (user) => {
  clearRoleListeners();
  state.user = user;
  state.companyProfile = null;
  state.staffProfile = null;

  if (!user) {
    state.role = "visitor";
    updateHeaderAuthUI();
    window.renderTalents();
    renderHiringCompaniesSection();
    syncOpenModalsWithRole();
    return;
  }

  const emailLower = (user.email || "").toLowerCase();

  if (emailLower === ADMIN_EMAIL) {
    state.role = "admin";
    state.staffProfile = {
      email: emailLower,
      nome: "João Pedro Morais da Silva Leite",
      cargo: "Fundador & Diretor Executivo",
      nivel: "diretor",
      comissaoPercent: 0,
      metaMensal: 0
    };
    subscribeAdminListeners();
    updateHeaderAuthUI();
    window.renderTalents();
    renderHiringCompaniesSection();
    syncOpenModalsWithRole();
    return;
  }

  try {
    const staffSnap = await getDoc(doc(db, "funcionarios", emailLower));
    if (staffSnap.exists() && staffSnap.data().ativo === true) {
      state.role = "staff";
      state.staffProfile = { id: staffSnap.id, ...staffSnap.data() };
      subscribeStaffListeners(emailLower, state.staffProfile.nivel === "diretor");
      updateHeaderAuthUI();
      window.renderTalents();
      renderHiringCompaniesSection();
      syncOpenModalsWithRole();
      return;
    }
  } catch (err) {
    console.warn("Erro verificar funcionário:", err?.message || err);
  }

  try {
    const empSnap = await getDoc(doc(db, "empresas", user.uid));
    if (empSnap.exists()) {
      state.role = "company";
      state.companyProfile = { id: empSnap.id, ...empSnap.data() };
      subscribeCompanyListeners(user.uid);
      updateHeaderAuthUI();
      window.renderTalents();
      renderHiringCompaniesSection();
      syncOpenModalsWithRole();
      return;
    }
  } catch (err) {
    console.warn("Erro verificar empresa:", err?.message || err);
  }

  state.role = "visitor";
  updateHeaderAuthUI();
  window.renderTalents();
  syncOpenModalsWithRole();
});

function subscribeCommonTeamListeners() {
  state.unsubs.push(
    onSnapshot(collection(db, "candidatos_privado"), (snap) => {
      state.privateContacts.clear();
      snap.forEach((d) => state.privateContacts.set(d.id, d.data()));
      renderAdminTalentsTable();
      populatePedroxSelectors();
    })
  );

  state.unsubs.push(
    onSnapshot(collection(db, "empresas"), (snap) => {
      state.empresas = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      populatePedroxSelectors();
      populateSaleCompanySelect();
      renderRegularidadeDashboard();
      if (isDirectorRole()) {
        renderTrialsAndPlansTab();
        renderSecurityAccountsManager();
      }
      if (state.role === "admin") {
        renderAdminCompaniesTable();
        renderAdminFinanceDashboard();
      }
    })
  );

  state.unsubs.push(
    onSnapshot(collection(db, "solicitacoes_vagas"), (snap) => {
      state.solicitacoes = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      populatePedroxSelectors();
      renderStaffRequestsList();
    })
  );

  state.unsubs.push(
    onSnapshot(collection(db, "avaliacoes"), (snap) => {
      state.avaliacoes = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      renderStaffEvaluationsList();
    })
  );

  state.unsubs.push(
    onSnapshot(collection(db, "suporte_chats"), (snap) => {
      state.suporteChats = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      renderTeamSupportChatList();
    })
  );
}

function subscribeStaffListeners(emailLower, isDir) {
  subscribeCommonTeamListeners();
  state.unsubs.push(
    onSnapshot(query(collection(db, "vendas_equipe"), where("vendedorEmail", "==", emailLower)), (snap) => {
      state.vendasEquipe = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      renderSalesDashboard();
    })
  );
  if (isDir) {
    state.unsubs.push(
      onSnapshot(collection(db, "funcionarios"), (snap) => {
        state.funcionarios = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        renderDirectorAccessPanel();
        renderSecurityAccountsManager();
      })
    );
  }
}

function subscribeAdminListeners() {
  subscribeCommonTeamListeners();

  state.unsubs.push(
    onSnapshot(collection(db, "funcionarios"), (snap) => {
      state.funcionarios = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      renderDirectorAccessPanel();
      renderSecurityAccountsManager();
      populateAdminSaleSellerSelect();
      renderSalesDashboard();
    })
  );

  state.unsubs.push(
    onSnapshot(collection(db, "financeiro"), (snap) => {
      state.financeiro = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      renderAdminFinanceDashboard();
    })
  );

  state.unsubs.push(
    onSnapshot(collection(db, "vendas_equipe"), (snap) => {
      state.vendasEquipe = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      renderSalesDashboard();
    })
  );
}

let companyExtraUnsubs = [];
function clearCompanyExtraListeners() {
  companyExtraUnsubs.forEach((fn) => {
    try { fn(); } catch (_) {}
  });
  companyExtraUnsubs = [];
  state.avaliacoesEmpresa = [];
  state.avaliacoesGerais = [];
  state.companySupportChat = null;
  state.companySupportMessages = [];
}

function subscribeCompanyListeners(uid) {
  state.unsubs.push(() => clearCompanyExtraListeners());

  state.unsubs.push(
    onSnapshot(doc(db, "empresas", uid), (snap) => {
      if (!snap.exists()) return;
      const wasPremium = isCompanyPremiumActive(state.companyProfile);
      state.companyProfile = { id: snap.id, ...snap.data() };
      const nowPremium = isCompanyPremiumActive(state.companyProfile);
      if (nowPremium && !wasPremium) subscribeCompanyPremiumData(uid);
      else if (!nowPremium) clearCompanyExtraListeners();
      updateHeaderAuthUI();
      renderCompanyDashboard();
      window.renderTalents();
    })
  );

  state.unsubs.push(
    onSnapshot(query(collection(db, "solicitacoes_vagas"), where("empresaUid", "==", uid)), (snap) => {
      state.solicitacoes = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      renderCompanyRequestsList();
    })
  );

  if (isCompanyPremiumActive(state.companyProfile)) {
    subscribeCompanyPremiumData(uid);
  }
}

function subscribeCompanyPremiumData(uid) {
  clearCompanyExtraListeners();
  companyExtraUnsubs.push(
    onSnapshot(query(collection(db, "avaliacoes"), where("empresaUid", "==", uid), where("visivelParaEmpresa", "==", true)), (snap) => {
      state.avaliacoesEmpresa = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderCompanyEvaluationsList();
    })
  );
  companyExtraUnsubs.push(
    onSnapshot(query(collection(db, "avaliacoes"), where("empresaUid", "==", "geral"), where("visivelParaEmpresa", "==", true)), (snap) => {
      state.avaliacoesGerais = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderCompanyEvaluationsList();
    })
  );
  companyExtraUnsubs.push(
    onSnapshot(doc(db, "suporte_chats", uid), (snap) => {
      state.companySupportChat = snap.exists() ? { id: snap.id, ...snap.data() } : null;
      renderCompanySupportChat();
    })
  );
  companyExtraUnsubs.push(
    onSnapshot(collection(db, "suporte_chats", uid, "mensagens"), (snap) => {
      state.companySupportMessages = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      renderCompanySupportChat();
    })
  );
}

// ============================================================================
// HEADER UI
// ============================================================================
function updateHeaderAuthUI() {
  const companyBtn = document.getElementById("header-company-btn");
  const teamBtn = document.getElementById("header-team-btn");
  const mobileCompanyBtn = document.getElementById("mobile-company-btn");
  const mobileTeamBtn = document.getElementById("mobile-team-btn");

  if (state.role === "company" && state.companyProfile) {
    const prem = isCompanyPremiumActive(state.companyProfile);
    const tierName = prem ? getPlanById(state.companyProfile.planoTier || "start").nome : "Minha Empresa";
    if (companyBtn) {
      companyBtn.innerHTML = `<i class="fa-solid ${prem ? "fa-crown" : "fa-building"}"></i><span>${esc(tierName)}</span>`;
      companyBtn.className = prem
        ? "hidden sm:inline-flex items-center gap-2 bg-brand-yellow hover:bg-brand-yellowHover text-brand-black font-extrabold text-xs sm:text-sm px-4 py-2.5 rounded-xl shadow-lg shadow-brand-yellow/20"
        : "hidden sm:inline-flex items-center gap-2 bg-brand-card hover:bg-neutral-800 text-brand-yellow border border-brand-yellow/50 font-bold text-xs sm:text-sm px-4 py-2.5 rounded-xl";
    }
    if (mobileCompanyBtn) mobileCompanyBtn.textContent = `Portal Empresa (${tierName})`;
  } else {
    if (companyBtn) {
      companyBtn.innerHTML = `<i class="fa-solid fa-building"></i><span>Área da Empresa</span>`;
      companyBtn.className = "hidden sm:inline-flex items-center gap-2 bg-brand-yellow hover:bg-brand-yellowHover text-brand-black font-bold text-xs sm:text-sm px-4 py-2.5 rounded-xl shadow-lg shadow-brand-yellow/10";
    }
    if (mobileCompanyBtn) mobileCompanyBtn.textContent = "Área da Empresa (CNPJ)";
  }

  if (state.role === "admin" || state.role === "staff") {
    const label = state.role === "admin" ? "Painel Diretor" : isDirectorRole() ? "Diretoria JP RH" : "Central JP RH";
    if (teamBtn) teamBtn.innerHTML = `<i class="fa-solid fa-robot text-brand-yellow"></i><span>${label}</span>`;
    if (mobileTeamBtn) mobileTeamBtn.textContent = `${label} + Pedrox`;
  } else {
    if (teamBtn) teamBtn.innerHTML = `<i class="fa-solid fa-shield-halved text-brand-yellow"></i><span>Equipe JP RH</span>`;
    if (mobileTeamBtn) mobileTeamBtn.textContent = "Equipe JP RH / Diretoria";
  }
}

function syncOpenModalsWithRole() {
  if (!document.getElementById("modal-company")?.classList.contains("hidden")) renderCompanyModalView();
  if (!document.getElementById("modal-admin")?.classList.contains("hidden")) renderTeamModalView();
}

// ============================================================================
// PUBLIC BANCO DE TALENTOS (DESTAQUE VIP NO TOPO!)
// ============================================================================
window.renderTalents = function () {
  const grid = document.getElementById("talents-grid");
  const emptyState = document.getElementById("talents-empty");
  const countEl = document.getElementById("talents-showing-count");
  if (!grid || !emptyState || !countEl) return;

  const searchTerm = (document.getElementById("talent-search")?.value || "").toLowerCase().trim();
  const areaFilter = document.getElementById("talent-filter-area")?.value || "todas";
  const dispFilter = document.getElementById("talent-filter-disp")?.value || "todas";
  const bairroFilter = document.getElementById("talent-filter-bairro")?.value || "todos";

  const filtered = state.talents.filter((cand) => {
    const matchesArea = areaFilter === "todas" || cand.area === areaFilter;
    const matchesDisp = dispFilter === "todas" || cand.disponibilidade === dispFilter;
    const matchesBairro = bairroFilter === "todos" || cand.bairro === bairroFilter;
    const skillsStr = Array.isArray(cand.habilidades) ? cand.habilidades.join(" ").toLowerCase() : "";
    const searchable = `${cand.cargo || ""} ${cand.area || ""} ${cand.resumo || ""} ${skillsStr} ${cand.codigo || ""}`.toLowerCase();
    return matchesArea && matchesDisp && matchesBairro && (!searchTerm || searchable.includes(searchTerm));
  });

  countEl.textContent = filtered.length;
  grid.innerHTML = "";
  if (filtered.length === 0) {
    emptyState.classList.remove("hidden");
    return;
  }
  emptyState.classList.add("hidden");

  const isTeam = state.role === "admin" || state.role === "staff";
  const isPremiumCompany = state.role === "company" && isCompanyPremiumActive(state.companyProfile);

  filtered.forEach((cand) => {
    const protectedName = cand.nomeProtegido || getProtectedName(cand.nomeCompleto);
    const skills = Array.isArray(cand.habilidades) ? cand.habilidades.slice(0, 4) : [];
    const dispBadgeColor = cand.disponibilidade === "Imediata" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-amber-500/15 text-amber-300 border-amber-500/30";
    const isEvaluated = cand.statusEntrevista === "entrevistado" && cand.notaMedia != null;
    const isVipCand = cand.planoCandidato === "vip" || cand.destaque === true;

    let actionBtnHtml = "";
    if (isTeam) {
      actionBtnHtml = `<button type="button" onclick="startPedroxForCandidate('${esc(cand.id)}')" class="py-2.5 px-3 rounded-xl bg-brand-yellow hover:bg-brand-yellowHover text-brand-black font-extrabold text-xs flex items-center justify-center gap-1.5"><i class="fa-solid fa-robot text-sm"></i><span>Entrevistar</span></button>`;
    } else if (isPremiumCompany) {
      actionBtnHtml = `<button type="button" onclick="openCompanyModal('avaliacoes')" class="py-2.5 px-3 rounded-xl bg-brand-yellow hover:bg-brand-yellowHover text-brand-black font-extrabold text-xs flex items-center justify-center gap-1.5"><i class="fa-solid fa-clipboard-check text-sm"></i><span>Avaliações</span></button>`;
    } else {
      actionBtnHtml = `<button type="button" onclick="openCompanyModal('plano')" class="py-2.5 px-3 rounded-xl bg-neutral-800 hover:bg-neutral-700 border border-brand-yellow/40 text-brand-yellow font-bold text-xs flex items-center justify-center gap-1.5"><i class="fa-solid fa-lock text-xs"></i><span>Avaliação JP RH</span></button>`;
    }

    const card = document.createElement("div");
    card.className = `bg-brand-card ${isVipCand ? "border-2 border-brand-yellow shadow-xl shadow-brand-yellow/10" : "border border-brand-border hover:border-brand-yellow/60"} rounded-2xl p-6 flex flex-col justify-between transition-all hover:-translate-y-1`;
    card.innerHTML = `
      <div>
        <div class="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div class="flex items-center gap-1.5">
            <span class="text-xs font-mono font-bold px-2.5 py-1 rounded-lg bg-brand-black text-brand-yellow border border-brand-border">${esc(cand.codigo || "JP-RH")}</span>
            ${isVipCand ? `<span class="text-[10px] font-extrabold uppercase px-2 py-1 rounded-lg bg-brand-yellow text-brand-black"><i class="fa-solid fa-crown mr-1"></i>VIP Topo</span>` : ""}
          </div>
          ${
            isEvaluated
              ? `<span class="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"><i class="fa-solid fa-star"></i> ${Number(cand.notaMedia).toFixed(1)}/10</span>`
              : `<span class="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full bg-neutral-800 text-neutral-400">Aguardando JP RH</span>`
          }
        </div>
        <div class="flex items-center gap-3 mb-3">
          <div class="w-11 h-11 rounded-xl ${isVipCand ? "bg-brand-yellow text-brand-black" : "bg-brand-black text-brand-yellow border border-brand-border"} flex items-center justify-center font-display font-extrabold text-base shrink-0">${esc(protectedName.substring(0, 2).toUpperCase())}</div>
          <div>
            <h3 class="font-display font-bold text-lg text-white leading-tight">${esc(protectedName)}</h3>
            <p class="text-brand-yellow font-semibold text-xs mt-0.5">${esc(cand.cargo)}</p>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2 text-xs text-neutral-400 bg-brand-black/60 rounded-xl p-3 mb-4 border border-brand-border/60">
          <div class="flex items-center gap-1.5 truncate"><i class="fa-solid fa-briefcase text-brand-yellow w-3.5"></i><span class="truncate">${esc(cand.experiencia)}</span></div>
          <div class="flex items-center gap-1.5 truncate"><i class="fa-solid fa-location-dot text-brand-yellow w-3.5"></i><span class="truncate">${esc(cand.bairro)}</span></div>
          <div class="flex items-center gap-1.5 truncate"><i class="fa-solid fa-graduation-cap text-brand-yellow w-3.5"></i><span class="truncate">${esc(cand.escolaridade || "Ensino Médio")}</span></div>
          <div><span class="inline-block px-2 py-0.5 rounded-md border text-[10px] font-bold ${dispBadgeColor}">${esc(cand.disponibilidade)}</span></div>
        </div>
        <p class="text-xs sm:text-sm text-neutral-300 line-clamp-2 leading-relaxed mb-4">${esc(cand.resumo)}</p>
        <div class="flex flex-wrap gap-1.5 mb-6">${skills.map((tag) => `<span class="text-[11px] font-medium px-2.5 py-1 rounded-lg bg-brand-black border border-brand-border text-neutral-300">${esc(tag)}</span>`).join("")}</div>
      </div>
      <div class="grid grid-cols-2 gap-2.5 pt-4 border-t border-brand-border/70">
        <button type="button" onclick="openTalentDetail('${esc(cand.id)}')" class="py-2.5 px-3 rounded-xl bg-brand-black hover:bg-neutral-900 border border-brand-border text-neutral-200 hover:text-white font-semibold text-xs">Ver Ficha</button>
        ${actionBtnHtml}
      </div>`;
    grid.appendChild(card);
  });
};

window.resetTalentFilters = function () {
  document.getElementById("talent-search").value = "";
  document.getElementById("talent-filter-area").value = "todas";
  document.getElementById("talent-filter-disp").value = "todas";
  document.getElementById("talent-filter-bairro").value = "todos";
  window.renderTalents();
};

window.openTalentDetail = function (id) {
  const cand = state.talents.find((c) => c.id === id);
  if (!cand) return;
  const protectedName = cand.nomeProtegido || getProtectedName(cand.nomeCompleto);
  const skills = Array.isArray(cand.habilidades) ? cand.habilidades : [];
  const isTeam = state.role === "admin" || state.role === "staff";
  const isPremiumCompany = state.role === "company" && isCompanyPremiumActive(state.companyProfile);

  const footerAction = isTeam
    ? `<button type="button" onclick="closeTalentDetailModal(); startPedroxForCandidate('${esc(cand.id)}')" class="w-full py-4 px-6 rounded-xl bg-brand-yellow text-brand-black font-extrabold text-sm flex items-center justify-center gap-2"><i class="fa-solid fa-robot text-lg"></i><span>Iniciar Entrevista com Pedrox</span></button>`
    : isPremiumCompany
    ? `<div class="bg-brand-black border border-brand-yellow/40 rounded-2xl p-4 space-y-3"><p class="text-xs text-neutral-300"><strong class="text-white">Entrevista exclusiva JP RH.</strong> Envie requisitos no Portal da Empresa para receber a avaliação do Pedrox.</p><div class="grid grid-cols-2 gap-2"><button type="button" onclick="closeTalentDetailModal(); openCompanyModal('requisitos')" class="py-2.5 rounded-xl bg-brand-yellow text-brand-black font-extrabold text-xs">Enviar Requisitos</button><button type="button" onclick="closeTalentDetailModal(); openCompanyModal('avaliacoes')" class="py-2.5 rounded-xl bg-brand-card border border-brand-border text-white font-bold text-xs">Ver Avaliações</button></div></div>`
    : `<div class="bg-brand-black border border-brand-yellow/40 rounded-2xl p-4 space-y-3"><p class="text-xs text-neutral-300"><i class="fa-solid fa-lock text-brand-yellow mr-1"></i>Entrevistas conduzidas exclusivamente pela equipe JP RH. Assine um dos 4 planos (a partir de R$ 50/mês) para contratar.</p><button type="button" onclick="closeTalentDetailModal(); openCompanyModal('plano')" class="w-full py-3 rounded-xl bg-brand-yellow text-brand-black font-extrabold text-xs">Ver Planos para Empresas</button></div>`;

  document.getElementById("modal-talent-detail-body").innerHTML = `
    <div class="flex items-center gap-2 mb-4">
      <span class="text-xs font-mono font-bold px-3 py-1 rounded-lg bg-brand-black text-brand-yellow border border-brand-border">Código: ${esc(cand.codigo || "JP-RH")}</span>
      ${cand.planoCandidato === "vip" || cand.destaque ? `<span class="text-xs font-extrabold px-2.5 py-1 rounded-lg bg-brand-yellow text-brand-black"><i class="fa-solid fa-crown mr-1"></i>Candidato VIP</span>` : ""}
    </div>
    <h3 class="font-display font-extrabold text-2xl text-white">${esc(protectedName)}</h3>
    <p class="text-brand-yellow font-bold text-base mb-5">${esc(cand.cargo)} • <span class="text-neutral-400 font-normal text-sm">${esc(cand.area)}</span></p>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-brand-black border border-brand-border rounded-2xl p-4 mb-5 text-xs">
      <div><span class="text-neutral-500 block">Experiência</span><strong class="text-white mt-0.5 block">${esc(cand.experiencia)}</strong></div>
      <div><span class="text-neutral-500 block">Bairro</span><strong class="text-white mt-0.5 block">${esc(cand.bairro)}</strong></div>
      <div><span class="text-neutral-500 block">Disponibilidade</span><strong class="text-emerald-400 mt-0.5 block">${esc(cand.disponibilidade)}</strong></div>
      <div><span class="text-neutral-500 block">Escolaridade</span><strong class="text-white mt-0.5 block">${esc(cand.escolaridade || "Ensino Médio")}</strong></div>
    </div>
    <div class="mb-5"><h4 class="text-xs font-bold uppercase text-neutral-400 mb-2">Resumo Profissional</h4><p class="text-sm text-neutral-200 leading-relaxed bg-brand-black/50 p-4 rounded-xl border border-brand-border/60">${esc(cand.resumo)}</p></div>
    <div class="mb-6"><h4 class="text-xs font-bold uppercase text-neutral-400 mb-2">Competências</h4><div class="flex flex-wrap gap-2">${skills.map((s) => `<span class="text-xs px-3 py-1.5 rounded-xl bg-brand-black border border-brand-border text-neutral-200">${esc(s)}</span>`).join("")}</div></div>
    ${footerAction}`;
  document.getElementById("modal-talent-detail").classList.remove("hidden");
};
window.closeTalentDetailModal = function () {
  document.getElementById("modal-talent-detail").classList.add("hidden");
};

// ============================================================================
// CANDIDATE REGISTRATION (GRÁTIS OU COM UPGRADE VIP R$ 20)
// ============================================================================
let regWantVip = false;
window.openRegisterTalentModal = function (wantVip = false) {
  regWantVip = Boolean(wantVip);
  const cb = document.getElementById("reg-want-vip");
  if (cb) cb.checked = regWantVip;
  document.getElementById("modal-register-talent").classList.remove("hidden");
};
window.closeRegisterTalentModal = function () {
  document.getElementById("modal-register-talent").classList.add("hidden");
};

window.handleRegisterTalent = async function (e) {
  e.preventDefault();
  const btn = document.getElementById("btn-submit-talent");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>Salvando currículo...</span>`;

  const nomeCompleto = document.getElementById("reg-nome").value.trim();
  const whatsapp = document.getElementById("reg-whatsapp").value.trim();
  const email = (document.getElementById("reg-email")?.value || "").trim();
  const cargo = document.getElementById("reg-cargo").value.trim();
  const area = document.getElementById("reg-area").value;
  const experiencia = document.getElementById("reg-experiencia-tempo").value;
  const bairro = document.getElementById("reg-bairro").value;
  const disponibilidade = document.getElementById("reg-disponibilidade").value;
  const escolaridade = document.getElementById("reg-escolaridade").value;
  const rawSkills = document.getElementById("reg-habilidades").value;
  const resumo = document.getElementById("reg-resumo").value.trim();
  const wantVip = Boolean(document.getElementById("reg-want-vip")?.checked);

  const skillsArray = rawSkills.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 15);
  const randomCode = `JP-${Math.floor(1000 + Math.random() * 8999)}`;
  const now = Date.now();
  const isTeam = state.role === "admin" || state.role === "staff";
  const nomeProtegido = getProtectedName(nomeCompleto);

  try {
    const candRef = doc(collection(db, "candidatos"));
    await setDoc(candRef, {
      codigo: randomCode,
      nomeProtegido,
      cargo,
      area,
      experiencia,
      bairro,
      disponibilidade,
      escolaridade,
      habilidades: skillsArray.length ? skillsArray : ["Proatividade", "Trabalho em Equipe"],
      resumo,
      verificado: isTeam,
      destaque: false,
      planoCandidato: wantVip ? "pendente_vip" : "gratuito",
      statusEntrevista: "aguardando",
      notaMedia: null,
      createdAt: now
    });
    await setDoc(doc(db, "candidatos_privado", candRef.id), { nomeCompleto, whatsapp, email, createdAt: now });

    document.getElementById("form-register-talent").reset();
    window.closeRegisterTalentModal();

    state.pendingCandidateVip = { id: candRef.id, codigo: randomCode, nomeProtegido };
    if (wantVip) {
      window.showToast(`Currículo salvo (${randomCode})! Agora conclua o Pix de R$ 20 para ativar seu Destaque VIP.`);
      window.openCandidateVipModal(state.pendingCandidateVip);
    } else {
      window.showToast(`Currículo cadastrado GRATUITAMENTE! Seu código é ${randomCode}. Se quiser passar na frente da fila (R$ 20), clique em Destaque VIP.`);
    }
  } catch (error) {
    console.error("Erro ao cadastrar candidato:", error);
    window.showToast("Não foi possível salvar seu cadastro. Verifique os campos.", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-check"></i><span>Salvar Currículo no Banco de Talentos</span>`;
  }
};

// ============================================================================
// COMPANY PORTAL (4 PLANOS + PIX QR CODE + SUPORTE CHAT PEDROX -> VENDEDOR)
// ============================================================================
let activeCompanyTab = "plano";

window.openCompanyModal = function (tab = "plano") {
  activeCompanyTab = tab;
  document.getElementById("modal-company").classList.remove("hidden");
  renderCompanyModalView();
};
window.closeCompanyModal = function () {
  document.getElementById("modal-company").classList.add("hidden");
};

window.switchCompanyAuthMode = function (mode, prefillEmail = "") {
  const tabs = {
    login: { btn: document.getElementById("comp-auth-tab-login"), pane: document.getElementById("form-company-login") },
    register: { btn: document.getElementById("comp-auth-tab-register"), pane: document.getElementById("form-company-register") },
    reset: { btn: document.getElementById("comp-auth-tab-reset"), pane: document.getElementById("form-company-reset") }
  };
  Object.entries(tabs).forEach(([key, { btn, pane }]) => {
    const active = key === mode;
    if (btn) {
      btn.className = active
        ? "py-2.5 px-3 rounded-xl font-bold text-xs sm:text-sm bg-brand-yellow text-brand-black"
        : "py-2.5 px-3 rounded-xl font-bold text-xs sm:text-sm text-neutral-400 hover:text-white";
    }
    if (pane) pane.classList.toggle("hidden", !active);
  });
  if (mode === "reset" && prefillEmail) {
    const el = document.getElementById("comp-reset-email");
    if (el) el.value = prefillEmail;
  }
};

function renderCompanyModalView() {
  const authView = document.getElementById("company-auth-view");
  const dashView = document.getElementById("company-dashboard-view");
  const nonCompanyNotice = document.getElementById("company-role-notice");

  if (state.role === "company" && state.companyProfile) {
    authView.classList.add("hidden");
    nonCompanyNotice.classList.add("hidden");
    dashView.classList.remove("hidden");
    renderCompanyDashboard();
    window.switchCompanyDashTab(activeCompanyTab);
  } else if (state.role === "admin" || state.role === "staff") {
    authView.classList.add("hidden");
    dashView.classList.add("hidden");
    nonCompanyNotice.classList.remove("hidden");
  } else {
    dashView.classList.add("hidden");
    nonCompanyNotice.classList.add("hidden");
    authView.classList.remove("hidden");
  }
}

window.handleCompanyLogin = async function (e) {
  e.preventDefault();
  const btn = document.getElementById("btn-company-login");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Entrando...`;
  try {
    await signInWithEmailAndPassword(auth, document.getElementById("comp-login-email").value.trim().toLowerCase(), document.getElementById("comp-login-password").value);
    document.getElementById("form-company-login").reset();
    window.showToast("Login realizado!");
  } catch (err) {
    window.showToast(mapAuthError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Entrar no Portal da Empresa`;
  }
};

window.handleCompanyRegister = async function (e) {
  e.preventDefault();
  const cnpjRaw = document.getElementById("comp-reg-cnpj").value.trim();
  if (!isValidCnpj(cnpjRaw)) return window.showToast("CNPJ inválido. Verifique os 14 dígitos.", "error");

  const btn = document.getElementById("btn-company-register");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Cadastrando...`;
  try {
    const email = document.getElementById("comp-reg-email").value.trim().toLowerCase();
    const razaoSocial = document.getElementById("comp-reg-razao").value.trim();
    const cred = await createUserWithEmailAndPassword(auth, email, document.getElementById("comp-reg-password").value);
    const now = Date.now();
    await setDoc(doc(db, "empresas", cred.user.uid), {
      uid: cred.user.uid,
      email,
      razaoSocial,
      nomeFantasia: document.getElementById("comp-reg-fantasia").value.trim() || razaoSocial,
      cnpj: formatCnpj(cnpjRaw),
      responsavel: document.getElementById("comp-reg-responsavel").value.trim(),
      whatsapp: document.getElementById("comp-reg-whatsapp").value.trim(),
      plano: "gratuito",
      planoTier: "gratuito",
      planoSolicitado: "",
      planoValor: 0,
      vendedorEmail: "",
      vendedorNome: "",
      premiumAte: null,
      createdAt: now,
      updatedAt: now
    });
    document.getElementById("form-company-register").reset();
    window.showToast("Empresa cadastrada! Escolha seu plano e pague direto via QR Code Pix.");
  } catch (err) {
    window.showToast(mapAuthError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Cadastrar Empresa com CNPJ`;
  }
};

window.handleLogout = async function () {
  await signOut(auth);
  window.closeCompanyModal();
  window.closeAdminModal();
  window.showToast("Sessão encerrada.");
};

window.switchCompanyDashTab = function (tab) {
  activeCompanyTab = tab;
  ["plano", "requisitos", "avaliacoes", "suporte"].forEach((t) => {
    const btn = document.getElementById(`comp-dash-tab-${t}`);
    const pane = document.getElementById(`comp-dash-pane-${t}`);
    if (!btn || !pane) return;
    if (t === tab) {
      btn.className = "px-4 py-2.5 rounded-xl text-xs sm:text-sm font-extrabold bg-brand-yellow text-brand-black";
      pane.classList.remove("hidden");
    } else {
      btn.className = "px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold bg-brand-black text-neutral-300 border border-brand-border hover:border-brand-yellow/50";
      pane.classList.add("hidden");
    }
  });
};

function renderCompanyPlanSelector() {
  const box = document.getElementById("comp-plan-selector");
  if (!box) return;
  box.innerHTML = COMPANY_PLANS.map((p) => {
    const selected = state.selectedPlanId === p.id;
    return `
      <button type="button" onclick="selectCompanyCheckoutPlan('${p.id}')"
              class="text-left p-3.5 rounded-2xl border transition-all ${selected ? "bg-brand-yellow/15 border-brand-yellow ring-1 ring-brand-yellow" : "bg-brand-card border-brand-border hover:border-brand-yellow/40"}">
        <div class="flex items-center justify-between gap-2">
          <strong class="text-white text-xs sm:text-sm">${esc(p.nome)}</strong>
          <span class="font-display font-extrabold text-brand-yellow text-sm">R$ ${p.valor}</span>
        </div>
        <p class="text-[11px] text-neutral-400 mt-1 line-clamp-2">${esc(p.subtitulo)}</p>
      </button>`;
  }).join("");

  const activePlan = getPlanById(state.selectedPlanId);
  const valEl = document.getElementById("pix-display-value");
  const nameEl = document.getElementById("pix-display-plan-name");
  const btnEl = document.getElementById("btn-company-pix-confirm");
  if (valEl) valEl.textContent = formatMoney(activePlan.valor);
  if (nameEl) nameEl.textContent = activePlan.nome;
  if (btnEl) btnEl.innerHTML = `<i class="fa-solid fa-check-double"></i><span>Já fiz o Pix de ${formatMoney(activePlan.valor)} (${esc(activePlan.nome)}) — Solicitar Ativação</span>`;

  // Generate live EMV Pix QR Code & Copia e Cola with exact plan value
  const payload = generatePixPayload({
    chavePix: state.pixConfig.chavePix,
    titular: state.pixConfig.titularPix,
    valor: activePlan.valor,
    txid: `JPRH${activePlan.id.toUpperCase()}${activePlan.valor}`
  });
  const qrImg = document.getElementById("comp-pix-qr-img");
  const brIn = document.getElementById("comp-pix-brcode");
  if (qrImg) qrImg.src = getPixQrImageUrl(payload, 200);
  if (brIn) brIn.value = payload;

  // Optional Card Checkout button if Admin configured link
  const cardBtn = document.getElementById("comp-card-checkout-btn");
  const cardLink = getCardLinkForPlan(activePlan.id);
  if (cardBtn) {
    if (cardLink) {
      cardBtn.href = cardLink;
      cardBtn.classList.remove("hidden");
    } else {
      cardBtn.classList.add("hidden");
    }
  }
}

window.selectCompanyCheckoutPlan = function (planId) {
  state.selectedPlanId = planId;
  renderCompanyPlanSelector();
};

function renderPixConfigUI() {
  const keyEl = document.getElementById("pix-display-key");
  const holderEl = document.getElementById("pix-display-holder");
  const bankEl = document.getElementById("pix-display-bank");
  if (keyEl) keyEl.textContent = state.pixConfig.chavePix || "(73) 98144-3993";
  if (holderEl) holderEl.textContent = state.pixConfig.titularPix || "João Pedro Morais da Silva Leite";
  if (bankEl) bankEl.textContent = state.pixConfig.bancoPix || "JP RH Eunápolis";

  const fields = [
    ["cfg-pix-key", "chavePix"],
    ["cfg-pix-holder", "titularPix"],
    ["cfg-pix-bank", "bancoPix"],
    ["cfg-card-cand-vip", "linkCartaoCandVip"],
    ["cfg-card-start", "linkCartaoStart"],
    ["cfg-card-impulso", "linkCartaoImpulso"],
    ["cfg-card-lider", "linkCartaoLider"],
    ["cfg-card-vip", "linkCartaoVip"]
  ];
  fields.forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = state.pixConfig[key] || "";
  });
}

window.copyPixKey = function () {
  const key = state.pixConfig.chavePix || "(73) 98144-3993";
  navigator.clipboard?.writeText(key).then(() => window.showToast(`Chave Pix copiada: ${key}`), () => window.showToast(`Chave Pix: ${key}`));
};

function renderCompanyDashboard() {
  const emp = state.companyProfile;
  if (!emp) return;
  const isPrem = isCompanyPremiumActive(emp);
  const isPend = emp.plano === "pendente";
  const currentTier = getPlanById(emp.planoTier || emp.planoSolicitado || "start");

  document.getElementById("comp-dash-name").textContent = emp.nomeFantasia || emp.razaoSocial;
  document.getElementById("comp-dash-cnpj").textContent = `CNPJ: ${emp.cnpj} • ${emp.email}`;

  document.getElementById("comp-force-pass-banner")?.classList.toggle("hidden", emp.exigirTrocaSenha !== true);

  const badge = document.getElementById("comp-dash-plan-badge");
  const daysLeft = emp.premiumAte ? Math.max(0, Math.ceil((Number(emp.premiumAte) - Date.now()) / (24 * 60 * 60 * 1000))) : 0;
  if (isPrem && emp.emTeste) {
    badge.className = "inline-flex items-center gap-1.5 text-xs font-extrabold px-3 py-1 rounded-full bg-purple-500/20 text-purple-300 border border-purple-400/40";
    badge.innerHTML = `<i class="fa-solid fa-flask-vial"></i> Período Experimental • ${esc(currentTier.nome)} • ${daysLeft} dia(s) restante(s) (até ${formatDate(emp.premiumAte)})`;
  } else if (isPrem) {
    badge.className = "inline-flex items-center gap-1.5 text-xs font-extrabold px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
    badge.innerHTML = `<i class="fa-solid fa-crown"></i> ${esc(currentTier.nome)} (R$ ${currentTier.valor}/mês) • Ativo até ${formatDate(emp.premiumAte)}`;
  } else if (isPend) {
    badge.className = "inline-flex items-center gap-1.5 text-xs font-extrabold px-3 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30";
    badge.innerHTML = `<i class="fa-solid fa-clock"></i> ${esc(currentTier.nome)} em Verificação`;
  } else {
    badge.className = "inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1 rounded-full bg-neutral-800 text-neutral-300 border border-brand-border";
    badge.innerHTML = `<i class="fa-solid fa-lock"></i> Conta Gratuita`;
  }

  document.getElementById("comp-upgrade-box").classList.toggle("hidden", isPrem || isPend);
  document.getElementById("comp-pending-box").classList.toggle("hidden", !isPend || isPrem);
  document.getElementById("comp-active-box").classList.toggle("hidden", !isPrem);

  if (isPrem) {
    document.getElementById("comp-active-plan-label").textContent = emp.emTeste
      ? `${currentTier.nome} — Período Experimental (${daysLeft} dia(s) restante(s))`
      : `${currentTier.nome} (${formatMoney(currentTier.valor)}/mês)`;
    document.getElementById("comp-active-until").textContent = formatDate(emp.premiumAte);
    document.getElementById("comp-active-benefits").innerHTML = currentTier.beneficios.map((b) => `<li class="flex items-center gap-2"><i class="fa-solid fa-check text-emerald-400"></i><span>${esc(b)}</span></li>`).join("");
  }

  document.getElementById("comp-req-locked").classList.toggle("hidden", isPrem);
  document.getElementById("comp-req-unlocked").classList.toggle("hidden", !isPrem);
  document.getElementById("comp-eval-locked").classList.toggle("hidden", isPrem);
  document.getElementById("comp-eval-unlocked").classList.toggle("hidden", !isPrem);
  document.getElementById("comp-support-locked").classList.toggle("hidden", isPrem);
  document.getElementById("comp-support-unlocked").classList.toggle("hidden", !isPrem);

  renderCompanyPlanSelector();
  populateCompanySellerDropdown();
  renderPixConfigUI();
  renderCompanyRequestsList();
  renderCompanyEvaluationsList();
  renderCompanySupportChat();
}

window.handleCompanyNotifyPix = async function () {
  const emp = state.companyProfile;
  if (!emp || !state.user) return;
  const plan = getPlanById(state.selectedPlanId);
  const sellerName = (document.getElementById("comp-plan-seller-select")?.value || "").trim();

  const btn = document.getElementById("btn-company-pix-confirm");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Registrando pagamento...`;
  try {
    const now = Date.now();
    await updateDoc(doc(db, "empresas", state.user.uid), {
      plano: "pendente",
      planoSolicitado: plan.id,
      planoValor: plan.valor,
      vendedorNome: sellerName,
      updatedAt: now
    });
    await addDoc(collection(db, "financeiro"), {
      tipo: "entrada",
      categoria: "Assinatura Premium",
      descricao: `${plan.nome} Mensal — ${emp.nomeFantasia || emp.razaoSocial}`,
      valor: plan.valor,
      status: "pendente",
      empresaUid: state.user.uid,
      empresaNome: emp.nomeFantasia || emp.razaoSocial,
      empresaCnpj: emp.cnpj,
      planoTier: plan.id,
      vendedorEmail: "",
      vendedorNome: sellerName,
      metodo: "Pix",
      competencia: currentMonthKey(),
      createdAt: now,
      paidAt: null
    });
    window.showToast(`Aviso de Pix (${plan.nome} — ${formatMoney(plan.valor)}) enviado ao Financeiro!`);
  } catch (err) {
    console.error(err);
    window.showToast("Não foi possível registrar o aviso.", "error");
  } finally {
    btn.disabled = false;
    renderCompanyPlanSelector();
  }
};

window.sendPixReceiptWhatsApp = function () {
  const emp = state.companyProfile;
  if (!emp) return;
  const plan = getPlanById(emp.planoSolicitado || state.selectedPlanId);
  const msg = `Olá *JP RH*! Acabei de realizar o Pix de *${formatMoney(plan.valor)}* para o *${plan.nome}*:\n\n*Empresa:* ${emp.razaoSocial}\n*CNPJ:* ${emp.cnpj}\n*E-mail:* ${emp.email}\n\n_(Enviando comprovante abaixo)_`;
  window.open(`https://wa.me/${WHATSAPP_JPRH}?text=${encodeURIComponent(msg)}`, "_blank", "noopener,noreferrer");
};

// ============================================================================
// COMPANY SUPPORT CHAT (PEDROX AI -> VENDEDORES JP RH)
// ============================================================================
function renderCompanySupportChat() {
  const feed = document.getElementById("comp-support-messages");
  const statusEl = document.getElementById("comp-support-status-badge");
  if (!feed) return;

  const chat = state.companySupportChat;
  if (statusEl) {
    if (chat?.status === "em_atendimento") {
      statusEl.className = "text-[11px] font-bold px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-400";
      statusEl.innerHTML = `<i class="fa-solid fa-headset mr-1"></i>Em atendimento com ${esc(chat.atendenteNome || "Vendedor JP RH")}`;
    } else if (chat?.status === "aguardando_humano") {
      statusEl.className = "text-[11px] font-bold px-3 py-1 rounded-full bg-amber-500/20 text-amber-300 animate-pulse";
      statusEl.innerHTML = `<i class="fa-solid fa-clock mr-1"></i>Direcionado para Vendedor JP RH`;
    } else {
      statusEl.className = "text-[11px] font-bold px-3 py-1 rounded-full bg-brand-yellow/20 text-brand-yellow";
      statusEl.innerHTML = `<i class="fa-solid fa-robot mr-1"></i>Pedrox IA Online`;
    }
  }

  if (!state.companySupportMessages.length) {
    feed.innerHTML = `
      <div class="bg-brand-card border border-brand-yellow/30 rounded-2xl p-4 text-xs text-neutral-200 max-w-[88%]">
        <strong class="text-brand-yellow flex items-center gap-1.5 mb-1"><i class="fa-solid fa-robot"></i> Pedrox • Assistente JP RH</strong>
        Olá, <strong>${esc(state.companyProfile?.nomeFantasia || "Parceiro")}</strong>! Sou o <strong>Pedrox</strong>. Posso te ensinar a mexer no site, enviar requisitos de vagas, ver avaliações ou tirar dúvidas sobre planos. Se preferir, também posso te transferir para um vendedor da equipe JP RH a qualquer momento!
      </div>`;
    return;
  }

  feed.innerHTML = state.companySupportMessages
    .map((m) => {
      const isCompany = m.autorTipo === "empresa";
      const isPedrox = m.autorTipo === "pedrox";
      return `
        <div class="flex ${isCompany ? "justify-end" : "justify-start"}">
          <div class="max-w-[85%] rounded-2xl px-4 py-3 text-xs leading-relaxed ${
            isCompany
              ? "bg-brand-yellow text-brand-black font-medium"
              : isPedrox
              ? "bg-brand-card border border-brand-yellow/30 text-neutral-100"
              : "bg-emerald-950/60 border border-emerald-500/40 text-emerald-50"
          }">
            <span class="text-[10px] font-extrabold uppercase tracking-wider block mb-1 ${isCompany ? "text-brand-black/70" : isPedrox ? "text-brand-yellow" : "text-emerald-400"}">
              ${isPedrox ? `<i class="fa-solid fa-robot mr-1"></i>` : !isCompany ? `<i class="fa-solid fa-headset mr-1"></i>` : ""}${esc(m.autorNome)} • ${formatDateTime(m.createdAt)}
            </span>
            <p class="whitespace-pre-line">${esc(m.texto)}</p>
          </div>
        </div>`;
    })
    .join("");
  feed.scrollTop = feed.scrollHeight;
}

window.sendCompanySupportQuickMsg = function (text) {
  const input = document.getElementById("comp-support-input");
  if (input) {
    input.value = text;
    window.handleCompanySendSupportMessage({ preventDefault: () => {} });
  }
};

window.handleCompanyEscalateToHuman = async function () {
  if (!state.user || !state.companyProfile) return;
  const uid = state.user.uid;
  const now = Date.now();
  const tier = getPlanById(state.companyProfile.planoTier || "start");
  try {
    await setDoc(
      doc(db, "suporte_chats", uid),
      {
        empresaUid: uid,
        empresaNome: state.companyProfile.nomeFantasia || state.companyProfile.razaoSocial,
        empresaCnpj: state.companyProfile.cnpj || "",
        planoNome: tier.nome,
        status: "aguardando_humano",
        atendenteNome: state.companySupportChat?.atendenteNome || "",
        ultimaMensagem: "Empresa solicitou atendimento com vendedor humano.",
        createdAt: state.companySupportChat?.createdAt || now,
        updatedAt: now
      },
      { merge: true }
    );
    await addDoc(collection(db, "suporte_chats", uid, "mensagens"), {
      autorTipo: "pedrox",
      autorNome: "Pedrox (IA JP RH)",
      texto: "Chamado transferido! Um vendedor/consultor da JP RH já foi notificado no painel interno e responderá você por aqui em instantes.",
      createdAt: now
    });
    window.showToast("Transferido para um vendedor humano da JP RH!", "info");
  } catch (err) {
    console.error(err);
    window.showToast("Erro ao transferir atendimento.", "error");
  }
};

window.handleCompanySendSupportMessage = async function (e) {
  e.preventDefault();
  if (!state.user || !state.companyProfile || !isCompanyPremiumActive(state.companyProfile)) return;

  const input = document.getElementById("comp-support-input");
  const texto = (input?.value || "").trim();
  if (!texto) return;

  const uid = state.user.uid;
  const emp = state.companyProfile;
  const tier = getPlanById(emp.planoTier || "start");
  const now = Date.now();
  input.value = "";

  const btn = document.getElementById("btn-comp-support-send");
  if (btn) btn.disabled = true;

  try {
    const currentStatus = state.companySupportChat?.status || "pedrox";
    const nextStatus = currentStatus === "em_atendimento" ? "em_atendimento" : currentStatus === "aguardando_humano" ? "aguardando_humano" : "pedrox";

    await setDoc(
      doc(db, "suporte_chats", uid),
      {
        empresaUid: uid,
        empresaNome: emp.nomeFantasia || emp.razaoSocial,
        empresaCnpj: emp.cnpj || "",
        planoNome: tier.nome,
        status: nextStatus,
        atendenteNome: state.companySupportChat?.atendenteNome || "",
        ultimaMensagem: texto.slice(0, 480),
        createdAt: state.companySupportChat?.createdAt || now,
        updatedAt: now
      },
      { merge: true }
    );

    await addDoc(collection(db, "suporte_chats", uid, "mensagens"), {
      autorTipo: "empresa",
      autorNome: emp.nomeFantasia || emp.razaoSocial,
      texto,
      createdAt: now
    });

    // If a human seller hasn't taken over yet, Pedrox responds first!
    if (nextStatus === "pedrox") {
      const reply = await pedroxSupportReply({
        message: texto,
        history: state.companySupportMessages,
        companyName: emp.nomeFantasia || emp.razaoSocial,
        planName: tier.nome
      });
      const replyTs = Date.now();
      await addDoc(collection(db, "suporte_chats", uid, "mensagens"), {
        autorTipo: "pedrox",
        autorNome: "Pedrox (IA JP RH)",
        texto: reply.resposta,
        createdAt: replyTs
      });
      await updateDoc(doc(db, "suporte_chats", uid), {
        status: reply.encaminharHumano ? "aguardando_humano" : "pedrox",
        ultimaMensagem: reply.resposta.slice(0, 480),
        updatedAt: replyTs
      });
    }
  } catch (err) {
    console.error("Erro chat suporte:", err);
    window.showToast("Erro ao enviar mensagem.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
};

// TEAM SUPPORT CHAT VIEW (FUNCIONÁRIOS / VENDEDORES & ADMIN)
function renderTeamSupportChatList() {
  const listEl = document.getElementById("team-support-list");
  const alertBadge = document.getElementById("team-support-alert-badge");
  const waitingCount = state.suporteChats.filter((c) => c.status === "aguardando_humano").length;

  if (alertBadge) {
    alertBadge.textContent = waitingCount > 0 ? `${waitingCount}` : "";
    alertBadge.classList.toggle("hidden", waitingCount === 0);
  }
  if (!listEl) return;

  if (!state.suporteChats.length) {
    listEl.innerHTML = `<p class="text-xs text-neutral-500 p-3">Nenhuma conversa de cliente assinante iniciada ainda.</p>`;
    return;
  }

  listEl.innerHTML = state.suporteChats
    .map((c) => {
      const selected = state.activeSupportChatId === c.id;
      const badge =
        c.status === "aguardando_humano"
          ? `<span class="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-500 text-brand-black">Chamar Vendedor!</span>`
          : c.status === "em_atendimento"
          ? `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">Em Atendimento</span>`
          : c.status === "resolvido"
          ? `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400">Resolvido</span>`
          : `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-400">Com Pedrox</span>`;

      return `
        <button type="button" onclick="openTeamSupportChat('${esc(c.id)}')"
                class="w-full text-left p-3.5 rounded-xl border transition-all ${selected ? "bg-brand-yellow/15 border-brand-yellow" : "bg-brand-black border-brand-border hover:border-brand-yellow/40"}">
          <div class="flex items-center justify-between gap-2 mb-1">
            <strong class="text-white text-xs sm:text-sm truncate">${esc(c.empresaNome)}</strong>
            ${badge}
          </div>
          <span class="text-[10px] text-brand-yellow block">${esc(c.planoNome || "Assinante")} • ${formatDateTime(c.updatedAt)}</span>
          <p class="text-[11px] text-neutral-400 truncate mt-1">${esc(c.ultimaMensagem || "")}</p>
        </button>`;
    })
    .join("");
}

window.openTeamSupportChat = function (chatId) {
  state.activeSupportChatId = chatId;
  renderTeamSupportChatList();

  if (state.activeSupportMsgUnsub) {
    try { state.activeSupportMsgUnsub(); } catch (_) {}
  }

  const chat = state.suporteChats.find((c) => c.id === chatId);
  const header = document.getElementById("team-support-chat-header");
  const placeholder = document.getElementById("team-support-placeholder");
  const activePane = document.getElementById("team-support-active-pane");

  if (!chat) return;
  placeholder?.classList.add("hidden");
  activePane?.classList.remove("hidden");
  if (header) {
    header.innerHTML = `
      <div>
        <strong class="text-white text-sm">${esc(chat.empresaNome)}</strong>
        <span class="text-xs text-brand-yellow ml-2">${esc(chat.planoNome || "")}</span>
        <span class="text-[11px] text-neutral-400 block">CNPJ: ${esc(chat.empresaCnpj || "—")}</span>
      </div>
      <div class="flex items-center gap-2">
        <button type="button" onclick="setTeamSupportStatus('${esc(chatId)}', 'em_atendimento')" class="px-3 py-1.5 rounded-lg bg-brand-yellow text-brand-black font-extrabold text-xs">Assumir</button>
        <button type="button" onclick="setTeamSupportStatus('${esc(chatId)}', 'resolvido')" class="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 font-bold text-xs">Resolver</button>
      </div>`;
  }

  state.activeSupportMsgUnsub = onSnapshot(collection(db, "suporte_chats", chatId, "mensagens"), (snap) => {
    state.activeSupportMessages = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    renderTeamSupportMessages();
  });
};

function renderTeamSupportMessages() {
  const feed = document.getElementById("team-support-messages");
  if (!feed) return;
  feed.innerHTML = state.activeSupportMessages
    .map((m) => {
      const isTeam = m.autorTipo === "funcionario";
      const isPedrox = m.autorTipo === "pedrox";
      return `
        <div class="flex ${isTeam ? "justify-end" : "justify-start"}">
          <div class="max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs ${
            isTeam ? "bg-brand-yellow text-brand-black font-medium" : isPedrox ? "bg-sky-950/60 border border-sky-500/30 text-sky-100" : "bg-brand-card border border-brand-border text-white"
          }">
            <span class="text-[10px] font-bold uppercase block mb-0.5 ${isTeam ? "text-brand-black/70" : isPedrox ? "text-sky-400" : "text-brand-yellow"}">${esc(m.autorNome)} • ${formatDateTime(m.createdAt)}</span>
            <p class="whitespace-pre-line">${esc(m.texto)}</p>
          </div>
        </div>`;
    })
    .join("");
  feed.scrollTop = feed.scrollHeight;
}

window.setTeamSupportStatus = async function (chatId, status) {
  const name = state.staffProfile?.nome || state.user?.email || "Vendedor JP RH";
  await updateDoc(doc(db, "suporte_chats", chatId), {
    status,
    atendenteNome: status === "em_atendimento" ? name : "",
    updatedAt: Date.now()
  });
  window.showToast(status === "em_atendimento" ? "Você assumiu este atendimento! Pedrox pausado para esta conversa." : "Atendimento marcado como resolvido (Pedrox reativado para futuras dúvidas).");
};

window.handleTeamSendSupportReply = async function (e) {
  e.preventDefault();
  if (!state.activeSupportChatId) return;
  const input = document.getElementById("team-support-input");
  const texto = (input?.value || "").trim();
  if (!texto) return;
  input.value = "";

  const name = state.staffProfile?.nome || state.user?.email || "Consultor JP RH";
  const now = Date.now();
  try {
    await addDoc(collection(db, "suporte_chats", state.activeSupportChatId, "mensagens"), {
      autorTipo: "funcionario",
      autorNome: name,
      texto,
      createdAt: now
    });
    await updateDoc(doc(db, "suporte_chats", state.activeSupportChatId), {
      status: "em_atendimento",
      atendenteNome: name,
      ultimaMensagem: texto.slice(0, 480),
      updatedAt: now
    });
  } catch (err) {
    console.error(err);
    window.showToast("Erro ao enviar resposta.", "error");
  }
};

// ============================================================================
// COMPANY REQUIREMENTS & EVALUATIONS
// ============================================================================
window.addCompanyReqChip = function (text) {
  const clean = String(text || "").trim();
  if (!clean || state.companyReqsDraft.length >= 15) return;
  if (!state.companyReqsDraft.some((r) => r.toLowerCase() === clean.toLowerCase())) {
    state.companyReqsDraft.push(clean);
    renderCompanyReqChips();
  }
};
window.addCompanyReqFromInput = function () {
  const input = document.getElementById("comp-req-chip-input");
  const val = (input?.value || "").trim();
  if (!val) return;
  val.split(",").forEach((i) => window.addCompanyReqChip(i));
  input.value = "";
};
window.removeCompanyReqChip = function (idx) {
  state.companyReqsDraft.splice(idx, 1);
  renderCompanyReqChips();
};
function renderCompanyReqChips() {
  const box = document.getElementById("comp-req-chips-list");
  if (!box) return;
  if (!state.companyReqsDraft.length) {
    box.innerHTML = `<span class="text-xs text-neutral-500">Adicione requisitos clicando nas sugestões ou digitando acima.</span>`;
    return;
  }
  box.innerHTML = state.companyReqsDraft
    .map((r, idx) => `<span class="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl bg-brand-yellow/15 text-brand-yellow border border-brand-yellow/30">${esc(r)}<button type="button" onclick="removeCompanyReqChip(${idx})" class="hover:text-white"><i class="fa-solid fa-xmark text-[10px]"></i></button></span>`)
    .join("");
}

window.handleCompanyCreateRequest = async function (e) {
  e.preventDefault();
  const emp = state.companyProfile;
  if (!emp || !isCompanyPremiumActive(emp)) return window.showToast("Ative um plano para enviar requisitos.", "error");
  const pendingInput = document.getElementById("comp-req-chip-input")?.value.trim();
  if (pendingInput) {
    pendingInput.split(",").forEach((i) => window.addCompanyReqChip(i));
    document.getElementById("comp-req-chip-input").value = "";
  }
  if (!state.companyReqsDraft.length) return window.showToast("Adicione pelo menos 1 requisito.", "error");

  const tituloVaga = document.getElementById("comp-req-titulo").value.trim();
  const area = document.getElementById("comp-req-area").value;
  const regime = document.getElementById("comp-req-regime").value.trim() || "CLT • Horário Comercial";
  const salario = document.getElementById("comp-req-salario").value.trim() || "A combinar";
  const descricao = document.getElementById("comp-req-descricao").value.trim();
  const now = Date.now();

  try {
    await addDoc(collection(db, "solicitacoes_vagas"), {
      empresaUid: state.user.uid,
      empresaNome: emp.nomeFantasia || emp.razaoSocial,
      empresaCnpj: emp.cnpj,
      tituloVaga,
      area,
      regime,
      salario,
      requisitos: [...state.companyReqsDraft],
      descricao,
      status: "aberta",
      createdAt: now
    });
    // Also publish privacy-safe card to empresas_contratando (visible to Candidatos VIP R$ 20!)
    await addDoc(collection(db, "empresas_contratando"), {
      empresaUid: state.user.uid,
      empresaNome: emp.nomeFantasia || emp.razaoSocial,
      tituloVaga,
      area,
      regime,
      salario,
      requisitos: [...state.companyReqsDraft],
      ativa: true,
      createdAt: now
    }).catch(() => {});

    document.getElementById("form-company-request").reset();
    state.companyReqsDraft = [];
    renderCompanyReqChips();
    window.showToast("Requisitos enviados! A equipe JP RH entrevistará os candidatos com o Pedrox.");
  } catch (err) {
    console.error(err);
    window.showToast("Erro ao enviar requisitos.", "error");
  }
};

function renderCompanyRequestsList() {
  const box = document.getElementById("comp-requests-list");
  if (!box) return;
  if (!state.solicitacoes.length) {
    box.innerHTML = `<div class="text-center py-6 text-xs text-neutral-500 border border-dashed border-brand-border rounded-2xl">Nenhuma solicitação cadastrada.</div>`;
    return;
  }
  box.innerHTML = state.solicitacoes
    .map((req) => `<div class="bg-brand-black border border-brand-border rounded-2xl p-4"><div class="flex justify-between gap-2 mb-2"><div><h5 class="font-bold text-white text-sm">${esc(req.tituloVaga)}</h5><span class="text-[11px] text-neutral-400">${esc(req.area)} • ${formatDate(req.createdAt)}</span></div><span class="text-[10px] font-bold px-2.5 py-1 rounded-full bg-brand-yellow/15 text-brand-yellow h-fit">${esc(req.status)}</span></div><div class="flex flex-wrap gap-1.5">${(req.requisitos || []).map((r) => `<span class="text-[11px] px-2 py-0.5 rounded bg-brand-card border border-brand-border text-neutral-300">${esc(r)}</span>`).join("")}</div></div>`)
    .join("");
}

function renderCompanyEvaluationsList() {
  const box = document.getElementById("comp-evaluations-list");
  if (!box) return;
  const map = new Map();
  [...state.avaliacoesEmpresa, ...state.avaliacoesGerais].forEach((ev) => map.set(ev.id, ev));
  const list = Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!list.length) {
    box.innerHTML = `<div class="text-center py-10 bg-brand-black/60 border border-dashed border-brand-border rounded-2xl p-6 text-xs text-neutral-400">Nenhuma avaliação liberada ainda.</div>`;
    return;
  }
  box.innerHTML = list
    .map((ev) => {
      const waMsg = `Olá *JP RH*! Gostaria de avançar contratação do candidato *${ev.candidatoNomeProtegido}* (${ev.candidatoCodigo}) — Nota ${Number(ev.notaGeral).toFixed(1)}/10.`;
      return `
        <div class="bg-brand-black border border-brand-border rounded-2xl p-5 space-y-3">
          <div class="flex justify-between items-start gap-3">
            <div><span class="text-xs font-mono font-bold text-brand-yellow">${esc(ev.candidatoCodigo)}</span><h5 class="font-display font-extrabold text-lg text-white">${esc(ev.candidatoNomeProtegido)}</h5><p class="text-xs text-neutral-400">${esc(ev.candidatoCargo)}</p></div>
            <div class="bg-brand-card border border-brand-yellow/40 rounded-xl px-3.5 py-1.5 text-center"><span class="text-[10px] text-neutral-400 block">Nota</span><strong class="text-xl text-brand-yellow font-extrabold">${Number(ev.notaGeral).toFixed(1)}/10</strong></div>
          </div>
          <p class="text-xs text-neutral-200 bg-brand-card/60 p-3 rounded-xl">${esc(ev.parecerPedrox)}</p>
          <a href="https://wa.me/${WHATSAPP_JPRH}?text=${encodeURIComponent(waMsg)}" target="_blank" class="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-brand-yellow text-brand-black font-extrabold text-xs"><i class="fa-brands fa-whatsapp"></i>Avançar Contratação com JP RH</a>
        </div>`;
    })
    .join("");
}

// ============================================================================
// TEAM / DIRECTOR / ADMIN PORTAL
// ============================================================================
let activeTeamTab = "pedrox";

window.openAdminModal = function (preferredTab = null) {
  if (preferredTab) activeTeamTab = preferredTab;
  document.getElementById("modal-admin").classList.remove("hidden");
  renderTeamModalView();
};
window.closeAdminModal = function () {
  document.getElementById("modal-admin").classList.add("hidden");
};
window.switchTeamAuthMode = function (mode, prefillEmail = "") {
  const tabs = {
    login: { btn: document.getElementById("team-auth-tab-login"), pane: document.getElementById("form-team-login") },
    signup: { btn: document.getElementById("team-auth-tab-signup"), pane: document.getElementById("form-team-signup") },
    reset: { btn: document.getElementById("team-auth-tab-reset"), pane: document.getElementById("form-team-reset") }
  };
  Object.entries(tabs).forEach(([key, { btn, pane }]) => {
    const active = key === mode;
    if (btn) {
      btn.className = active
        ? "py-2.5 px-2.5 rounded-xl font-bold text-xs bg-brand-yellow text-brand-black"
        : "py-2.5 px-2.5 rounded-xl font-bold text-xs text-neutral-400 hover:text-white";
    }
    if (pane) pane.classList.toggle("hidden", !active);
  });
  if (mode === "reset" && prefillEmail) {
    const el = document.getElementById("team-reset-email");
    if (el) el.value = prefillEmail;
  }
};

function renderTeamModalView() {
  const loginView = document.getElementById("admin-login-view");
  const dashView = document.getElementById("admin-dashboard-view");
  const roleMismatch = document.getElementById("team-role-mismatch");

  if (state.role === "admin" || state.role === "staff") {
    loginView.classList.add("hidden");
    roleMismatch.classList.add("hidden");
    dashView.classList.remove("hidden");

    const isAdmin = state.role === "admin";
    const isDir = isDirectorRole();

    document.getElementById("team-header-role").textContent = isAdmin
      ? "Diretor Geral / Admin Master • Controle Total & Financeiro"
      : isDir
      ? `Diretoria JP RH • ${state.staffProfile?.cargo || "Diretor"}`
      : `Funcionário JP RH • ${state.staffProfile?.cargo || "Consultor"}`;
    document.getElementById("team-header-user").textContent = state.staffProfile?.nome || state.user?.email || "Equipe JP RH";

    const secEmailEl = document.getElementById("sec-account-email");
    if (secEmailEl) secEmailEl.textContent = state.user?.email || "";

    document.querySelectorAll(".admin-only-el").forEach((el) => el.classList.toggle("hidden", !isAdmin));
    document.querySelectorAll(".director-only-el").forEach((el) => el.classList.toggle("hidden", !isDir));

    const allowedTabs = isAdmin
      ? ["pedrox", "curriculos", "regularidade", "suporte", "vendas", "empresas", "financeiro", "diretoria", "seguranca"]
      : isDir
      ? ["pedrox", "curriculos", "regularidade", "suporte", "vendas", "diretoria", "seguranca"]
      : ["pedrox", "curriculos", "regularidade", "suporte", "vendas", "seguranca"];

    if (!allowedTabs.includes(activeTeamTab)) activeTeamTab = "pedrox";
    window.switchTeamTab(activeTeamTab);

    document.getElementById("team-force-pass-banner")?.classList.toggle("hidden", state.staffProfile?.exigirTrocaSenha !== true);

    populatePedroxSelectors();
    populateSaleCompanySelect();
    renderAdminTalentsTable();
    renderStaffRequestsList();
    renderStaffEvaluationsList();
    renderRegularidadeDashboard();
    renderTeamSupportChatList();
    renderSalesDashboard();
    if (isDir) {
      renderDirectorAccessPanel();
      renderTrialsAndPlansTab();
      renderSecurityAccountsManager();
    }
    if (isAdmin) {
      renderAdminCompaniesTable();
      renderAdminFinanceDashboard();
      renderAdminVitrineTable();
      populateAdminSaleSellerSelect();
      renderPixConfigUI();
    }
  } else if (state.role === "company") {
    loginView.classList.add("hidden");
    dashView.classList.add("hidden");
    roleMismatch.classList.remove("hidden");
  } else {
    dashView.classList.add("hidden");
    roleMismatch.classList.add("hidden");
    loginView.classList.remove("hidden");
  }
}

window.handleAdminLogin = async function (e) {
  e.preventDefault();
  const btn = document.getElementById("btn-team-login");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Entrando...`;
  try {
    await signInWithEmailAndPassword(auth, document.getElementById("admin-email-input").value.trim().toLowerCase(), document.getElementById("admin-password-input").value);
    document.getElementById("form-team-login").reset();
    window.showToast("Acesso liberado ao Painel JP RH!");
  } catch (err) {
    window.showToast(mapAuthError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Entrar no Painel JP RH`;
  }
};

window.handleStaffFirstAccess = async function (e) {
  e.preventDefault();
  const email = document.getElementById("staff-signup-email").value.trim().toLowerCase();
  const btn = document.getElementById("btn-staff-signup");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Ativando...`;
  try {
    await createUserWithEmailAndPassword(auth, email, document.getElementById("staff-signup-password").value);
    const staffSnap = await getDoc(doc(db, "funcionarios", email));
    if (!staffSnap.exists() || staffSnap.data().ativo !== true) {
      await signOut(auth);
      window.showToast("E-mail ainda não autorizado pela Diretoria JP RH.", "error");
    } else {
      document.getElementById("form-team-signup").reset();
      window.showToast("Acesso ativado com sucesso!");
    }
  } catch (err) {
    window.showToast(mapAuthError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Ativar Acesso de Funcionário`;
  }
};

window.switchTeamTab = function (tab) {
  if (["diretoria", "testes"].includes(tab) && !isDirectorRole()) return window.showToast("Acesso exclusivo da Diretoria e Admin.", "error");
  if (["empresas", "financeiro"].includes(tab) && state.role !== "admin") return window.showToast("Acesso exclusivo do Administrador.", "error");
  activeTeamTab = tab;
  ["pedrox", "curriculos", "regularidade", "suporte", "vendas", "testes", "empresas", "financeiro", "diretoria", "seguranca"].forEach((t) => {
    const btn = document.getElementById(`team-tab-btn-${t}`);
    const pane = document.getElementById(`team-tab-pane-${t}`);
    if (!btn || !pane) return;
    if (t === tab) {
      btn.classList.add("bg-brand-yellow", "text-brand-black", "font-extrabold");
      btn.classList.remove("bg-brand-black", "text-neutral-300", "border", "border-brand-border");
      pane.classList.remove("hidden");
    } else {
      btn.classList.remove("bg-brand-yellow", "text-brand-black", "font-extrabold");
      btn.classList.add("bg-brand-black", "text-neutral-300", "border", "border-brand-border");
      pane.classList.add("hidden");
    }
  });
};

// ============================================================================
// ABA REGULARIDADE DOS PLANOS (PARA TODOS OS FUNCIONÁRIOS & DIRETORIA)
// ============================================================================
window.setRegularidadeFilter = function (filter) {
  state.regularidadeFilter = filter;
  renderRegularidadeDashboard();
};

function renderRegularidadeDashboard() {
  const tbody = document.getElementById("regularidade-tbody");
  if (!tbody) return;

  const enriched = state.empresas.map((emp) => ({ emp, reg: getCompanyRegularity(emp) }));
  const counts = {
    regular: enriched.filter((x) => x.reg.code === "regular").length,
    vencendo: enriched.filter((x) => x.reg.code === "vencendo").length,
    irregular: enriched.filter((x) => x.reg.code === "irregular").length,
    pendente: enriched.filter((x) => x.reg.code === "pendente").length
  };

  document.getElementById("reg-kpi-regular").textContent = counts.regular;
  document.getElementById("reg-kpi-vencendo").textContent = counts.vencendo;
  document.getElementById("reg-kpi-irregular").textContent = counts.irregular;
  document.getElementById("reg-kpi-pendente").textContent = counts.pendente;

  document.querySelectorAll(".reg-filter-btn").forEach((b) => {
    const active = b.dataset.filter === state.regularidadeFilter;
    b.className = active
      ? "reg-filter-btn px-3 py-1.5 rounded-lg text-xs font-extrabold bg-brand-yellow text-brand-black"
      : "reg-filter-btn px-3 py-1.5 rounded-lg text-xs font-semibold bg-brand-black border border-brand-border text-neutral-300 hover:border-brand-yellow/50";
  });

  const filtered = state.regularidadeFilter === "todos" ? enriched : enriched.filter((x) => x.reg.code === state.regularidadeFilter);
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-neutral-500 text-xs">Nenhuma empresa encontrada neste status.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map(({ emp, reg }) => {
      const tier = getPlanById(emp.planoTier || emp.planoSolicitado || "start");
      const cleanPhone = (emp.whatsapp || "").replace(/\D/g, "");
      const waText =
        reg.code === "irregular"
          ? `Olá *${emp.responsavel || emp.nomeFantasia}*! Aqui é da equipe *JP RH*. Identificamos que a assinatura do *${tier.nome}* (${emp.cnpj}) está vencida. Podemos ajudar a regularizar agora para não interromper suas avaliações com o Pedrox?`
          : reg.code === "vencendo"
          ? `Olá *${emp.responsavel || emp.nomeFantasia}*! Aqui é da equipe *JP RH*. Seu *${tier.nome}* vence em breve (${formatDate(emp.premiumAte)}). Deseja renovar por mais 30 dias via Pix?`
          : reg.code === "pendente"
          ? `Olá *${emp.responsavel || emp.nomeFantasia}*! Vimos a solicitação do *${tier.nome}* no portal JP RH. Pode enviar o comprovante do Pix por aqui para agilizarmos sua liberação?`
          : `Olá *${emp.responsavel || emp.nomeFantasia}*! Aqui é da equipe *JP RH*. Vi o cadastro da sua empresa no portal e gostaria de apresentar nossos 4 planos (a partir de R$ 50/mês) com entrevistas feitas pela IA Pedrox!`;

      return `
        <tr class="hover:bg-brand-black/40">
          <td class="py-3 px-3"><strong class="text-white text-sm block">${esc(emp.nomeFantasia || emp.razaoSocial)}</strong><span class="text-xs font-mono text-neutral-400">${esc(emp.cnpj)}</span></td>
          <td class="py-3 px-3 text-xs"><span class="text-white font-semibold block">${emp.plano === "gratuito" ? "Sem plano" : `${esc(tier.nome)} (R$ ${tier.valor})`}</span><span class="text-neutral-400">${esc(emp.responsavel)}</span></td>
          <td class="py-3 px-3"><span class="inline-block text-[10px] font-extrabold px-2.5 py-1 rounded-full border ${reg.badge}">${esc(reg.label)}</span><span class="text-[11px] text-neutral-400 block mt-0.5">${esc(reg.detail)}</span></td>
          <td class="py-3 px-3 text-xs text-neutral-300">${emp.premiumAte ? formatDate(emp.premiumAte) : "—"}</td>
          <td class="py-3 px-3 text-right">
            ${
              cleanPhone
                ? `<a href="https://wa.me/55${cleanPhone}?text=${encodeURIComponent(waText)}" target="_blank" rel="noopener noreferrer"
                      class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${reg.code === "irregular" ? "bg-red-500 text-white" : reg.code === "vencendo" || reg.code === "pendente" ? "bg-brand-yellow text-brand-black" : "bg-brand-card border border-brand-border text-emerald-400"} font-bold text-xs">
                     <i class="fa-brands fa-whatsapp"></i><span>${reg.code === "irregular" ? "Cobrar Regularização" : reg.code === "vencendo" ? "Renovar" : reg.code === "pendente" ? "Pedir Comprovante" : "Contatar"}</span>
                   </a>`
                : `<span class="text-xs text-neutral-500">Sem WhatsApp</span>`
            }
          </td>
        </tr>`;
    })
    .join("");
}

// ============================================================================
// PEDROX INTERVIEWS (KEEP ALL FUNCTIONS)
// ============================================================================
function populatePedroxSelectors() {
  const candSelect = document.getElementById("pedrox-candidate-select");
  const reqSelect = document.getElementById("pedrox-request-select");
  if (!candSelect || !reqSelect) return;
  const prevC = candSelect.value;
  candSelect.innerHTML = `<option value="">— Selecione um candidato —</option>`;
  state.talents.forEach((c) => {
    const priv = state.privateContacts.get(c.id);
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `${c.codigo || "JP"} ${c.planoCandidato === "vip" || c.destaque ? "★VIP" : ""} • ${priv?.nomeCompleto || c.nomeProtegido} — ${c.cargo}`;
    candSelect.appendChild(opt);
  });
  if (prevC) candSelect.value = prevC;

  const prevR = reqSelect.value;
  reqSelect.innerHTML = `<option value="">— Digitar requisitos manualmente —</option>`;
  state.solicitacoes.forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = `${r.empresaNome} • ${r.tituloVaga}`;
    reqSelect.appendChild(opt);
  });
  if (prevR) reqSelect.value = prevR;
}

window.startPedroxForCandidate = function (candId) {
  window.openAdminModal("pedrox");
  setTimeout(() => {
    const sel = document.getElementById("pedrox-candidate-select");
    if (sel) {
      sel.value = candId;
      window.onPedroxCandidateChange();
    }
  }, 100);
};

window.onPedroxCandidateChange = function () {
  const cand = state.talents.find((c) => c.id === document.getElementById("pedrox-candidate-select")?.value);
  const infoBox = document.getElementById("pedrox-candidate-info");
  if (!infoBox) return;
  if (!cand) return infoBox.classList.add("hidden");
  const priv = state.privateContacts.get(cand.id);
  const phone = priv?.whatsapp || "";
  const clean = phone.replace(/\D/g, "");
  infoBox.classList.remove("hidden");
  infoBox.innerHTML = `<div class="flex flex-wrap justify-between items-center gap-2"><div><strong class="text-white text-sm">${esc(priv?.nomeCompleto || cand.nomeProtegido)}</strong><span class="text-xs text-brand-yellow ml-2">${esc(cand.cargo)}</span></div>${clean ? `<a href="https://wa.me/55${clean}" target="_blank" class="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 text-xs font-bold"><i class="fa-brands fa-whatsapp mr-1"></i>${esc(phone)}</a>` : ""}</div>`;
  const cargoIn = document.getElementById("pedrox-cargo-input");
  if (cargoIn && !cargoIn.value.trim()) cargoIn.value = cand.cargo || "";
};

window.onPedroxRequestChange = function () {
  const req = state.solicitacoes.find((r) => r.id === document.getElementById("pedrox-request-select")?.value);
  if (!req) return;
  document.getElementById("pedrox-cargo-input").value = req.tituloVaga || "";
  document.getElementById("pedrox-requisitos-input").value = (req.requisitos || []).join(", ");
  document.getElementById("pedrox-descricao-input").value = req.descricao || "";
};

window.handlePedroxGenerateQuestions = async function () {
  const reqRaw = document.getElementById("pedrox-requisitos-input").value.trim();
  if (!reqRaw) return window.showToast("Informe os requisitos da empresa.", "error");
  const cand = state.talents.find((c) => c.id === document.getElementById("pedrox-candidate-select").value) || null;
  const req = state.solicitacoes.find((r) => r.id === document.getElementById("pedrox-request-select").value) || null;
  const btn = document.getElementById("btn-pedrox-generate");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Pedrox gerando perguntas...`;
  try {
    const res = await pedroxGenerateQuestions({
      cargo: document.getElementById("pedrox-cargo-input").value.trim() || cand?.cargo || "Profissional",
      empresaNome: req?.empresaNome || "Empresa Parceira JP RH",
      requisitos: reqRaw,
      descricao: document.getElementById("pedrox-descricao-input").value.trim(),
      candidato: cand
    });
    state.pedrox = {
      resumoEstrategico: res.resumoEstrategico,
      usedAI: res.usedAI,
      modelUsed: res.modelUsed,
      perguntas: res.perguntas.map((p) => ({ ...p, respostaResumo: "", nota: 8 }))
    };
    renderPedroxQuestionsBoard();
    window.showToast(res.usedAI ? `Pedrox (Gemini AI) gerou ${res.perguntas.length} perguntas!` : `Pedrox gerou ${res.perguntas.length} perguntas!`, "info");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i><span>Gerar Perguntas com Pedrox</span>`;
  }
};

function renderPedroxQuestionsBoard() {
  const wrap = document.getElementById("pedrox-questions-wrapper");
  if (!state.pedrox.perguntas.length) return wrap.classList.add("hidden");
  wrap.classList.remove("hidden");
  document.getElementById("pedrox-strategy-summary").textContent = state.pedrox.resumoEstrategico;
  document.getElementById("pedrox-engine-badge").innerHTML = state.pedrox.usedAI ? `<i class="fa-solid fa-sparkles"></i> Pedrox • Gemini AI` : `<i class="fa-solid fa-robot"></i> Pedrox • Motor RH`;
  document.getElementById("pedrox-questions-list").innerHTML = state.pedrox.perguntas
    .map(
      (p, idx) => `
      <div class="bg-brand-black border border-brand-border rounded-2xl p-4 space-y-2.5">
        <div class="flex justify-between items-center gap-2">
          <div class="flex items-center gap-2"><span class="w-6 h-6 rounded-lg bg-brand-yellow text-brand-black font-extrabold text-xs flex items-center justify-center">${idx + 1}</span><span class="text-xs font-bold text-brand-yellow">${esc(p.criterio)}</span></div>
          <div class="flex items-center gap-1.5"><span class="text-[11px] text-neutral-400">Nota:</span><input type="number" min="0" max="10" step="0.5" value="${p.nota}" onchange="updatePedroxQuestionScore(${idx}, this.value)" class="w-16 px-2 py-1 rounded-lg bg-brand-card border border-brand-yellow/50 text-brand-yellow font-bold text-xs text-center"></div>
        </div>
        <p class="text-sm font-semibold text-white">"${esc(p.pergunta)}"</p>
        <p class="text-[11px] text-neutral-400"><strong class="text-brand-yellow">Observar:</strong> ${esc(p.oQueObservar)}</p>
        <textarea rows="2" oninput="updatePedroxQuestionAnswer(${idx}, this.value)" placeholder="Resumo da resposta do candidato..." class="w-full px-3 py-2 rounded-xl bg-brand-card border border-brand-border text-xs text-white">${esc(p.respostaResumo)}</textarea>
      </div>`
    )
    .join("");
  updatePedroxAverageUI();
}
window.updatePedroxQuestionScore = function (idx, val) {
  if (state.pedrox.perguntas[idx]) {
    state.pedrox.perguntas[idx].nota = Math.min(10, Math.max(0, Number(val) || 0));
    updatePedroxAverageUI();
  }
};
window.updatePedroxQuestionAnswer = function (idx, val) {
  if (state.pedrox.perguntas[idx]) state.pedrox.perguntas[idx].respostaResumo = val;
};
function computePedroxAverage() {
  if (!state.pedrox.perguntas.length) return 0;
  return Math.round((state.pedrox.perguntas.reduce((a, p) => a + (Number(p.nota) || 0), 0) / state.pedrox.perguntas.length) * 10) / 10;
}
function updatePedroxAverageUI() {
  const el = document.getElementById("pedrox-avg-score");
  if (el) el.textContent = computePedroxAverage().toFixed(1);
}

window.handlePedroxGenerateReport = async function () {
  if (!state.pedrox.perguntas.length) return;
  const cand = state.talents.find((c) => c.id === document.getElementById("pedrox-candidate-select").value);
  const req = state.solicitacoes.find((r) => r.id === document.getElementById("pedrox-request-select").value);
  const res = await pedroxGenerateEvaluation({
    cargo: document.getElementById("pedrox-cargo-input").value.trim() || cand?.cargo || "Profissional",
    empresaNome: req?.empresaNome || "Empresa JP RH",
    requisitos: document.getElementById("pedrox-requisitos-input").value.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean),
    candidatoNomeProtegido: cand?.nomeProtegido || "Candidato JP RH",
    perguntasComRespostas: state.pedrox.perguntas,
    notaGeral: computePedroxAverage()
  });
  document.getElementById("pedrox-pontos-fortes").value = res.pontosFortes;
  document.getElementById("pedrox-pontos-atencao").value = res.pontosAtencao;
  document.getElementById("pedrox-parecer-final").value = res.parecerPedrox;
  document.getElementById("pedrox-recomendacao").value = res.recomendacao;
  window.showToast("Parecer consolidado pelo Pedrox!");
};

window.handleSaveEvaluation = async function (e) {
  e.preventDefault();
  const cand = state.talents.find((c) => c.id === document.getElementById("pedrox-candidate-select").value);
  if (!cand) return window.showToast("Selecione o candidato.", "error");
  const req = state.solicitacoes.find((r) => r.id === document.getElementById("pedrox-request-select").value) || null;
  const notaGeral = computePedroxAverage();
  await addDoc(collection(db, "avaliacoes"), {
    candidatoId: cand.id,
    candidatoCodigo: cand.codigo || "JP-RH",
    candidatoNomeProtegido: cand.nomeProtegido || "Candidato JP RH",
    candidatoCargo: document.getElementById("pedrox-cargo-input").value.trim() || cand.cargo,
    solicitacaoId: req ? req.id : "",
    empresaUid: req ? req.empresaUid : "geral",
    empresaNome: req ? req.empresaNome : "Empresas JP RH",
    requisitosAvaliados: document.getElementById("pedrox-requisitos-input").value.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean),
    entrevistadorEmail: state.user?.email || "",
    entrevistadorNome: state.staffProfile?.nome || state.user?.email || "Equipe JP RH",
    perguntasPedrox: state.pedrox.perguntas.map((p) => ({ criterio: p.criterio, tipo: p.tipo, pergunta: p.pergunta, respostaResumo: p.respostaResumo || "", nota: Number(p.nota) || 0 })),
    notaGeral,
    pontosFortes: document.getElementById("pedrox-pontos-fortes").value.trim() || "Bom desempenho.",
    pontosAtencao: document.getElementById("pedrox-pontos-atencao").value.trim() || "Acompanhamento padrão.",
    parecerPedrox: document.getElementById("pedrox-parecer-final").value.trim() || `Nota ${notaGeral}/10.`,
    recomendacao: document.getElementById("pedrox-recomendacao").value,
    visivelParaEmpresa: document.getElementById("pedrox-visivel-empresa").checked,
    geradoComIA: Boolean(state.pedrox.usedAI),
    createdAt: Date.now()
  });
  await updateDoc(doc(db, "candidatos", cand.id), { statusEntrevista: "entrevistado", notaMedia: notaGeral, verificado: true });
  state.pedrox.perguntas = [];
  document.getElementById("pedrox-questions-wrapper").classList.add("hidden");
  window.showToast(`Avaliação salva (${notaGeral}/10)!`);
};

function renderStaffRequestsList() {
  const box = document.getElementById("staff-requests-list");
  if (!box) return;
  if (!state.solicitacoes.length) return (box.innerHTML = `<p class="text-xs text-neutral-500">Nenhuma solicitação ainda.</p>`);
  box.innerHTML = state.solicitacoes
    .map((r) => `<div class="bg-brand-black border border-brand-border rounded-xl p-3 flex flex-wrap justify-between items-center gap-2"><div><strong class="text-white text-xs">${esc(r.tituloVaga)}</strong> <span class="text-[10px] text-brand-yellow">${esc(r.empresaNome)}</span><p class="text-[11px] text-neutral-400">${(r.requisitos || []).map(esc).join(", ")}</p></div><button type="button" onclick="loadRequestIntoPedrox('${esc(r.id)}')" class="px-3 py-1.5 rounded-lg bg-brand-yellow text-brand-black font-bold text-xs">Usar no Pedrox</button></div>`)
    .join("");
}
window.loadRequestIntoPedrox = function (id) {
  const sel = document.getElementById("pedrox-request-select");
  if (sel) { sel.value = id; window.onPedroxRequestChange(); }
};
function renderStaffEvaluationsList() {
  const box = document.getElementById("staff-evaluations-list");
  if (!box) return;
  if (!state.avaliacoes.length) return (box.innerHTML = `<p class="text-xs text-neutral-500">Nenhuma avaliação registrada.</p>`);
  box.innerHTML = state.avaliacoes
    .map((ev) => `<div class="bg-brand-black border border-brand-border rounded-xl p-3 flex flex-wrap justify-between items-center gap-2"><div><strong class="text-white text-xs">${esc(ev.candidatoCodigo)} • ${esc(ev.candidatoNomeProtegido)}</strong> <span class="text-emerald-400 text-xs font-bold">${Number(ev.notaGeral).toFixed(1)}/10</span><p class="text-[11px] text-neutral-400">${esc(ev.empresaNome)} • ${esc(ev.entrevistadorNome)}</p></div><button type="button" onclick="deleteEvaluation('${esc(ev.id)}')" class="p-1.5 rounded-lg bg-brand-card text-neutral-400 hover:text-red-400"><i class="fa-solid fa-trash text-xs"></i></button></div>`)
    .join("");
}
window.deleteEvaluation = async function (id) {
  await deleteDoc(doc(db, "avaliacoes", id));
  window.showToast("Avaliação excluída.");
};

// ============================================================================
// VENDAS & COMISSÕES DA EQUIPE
// ============================================================================
function populateSaleCompanySelect() {
  const sel = document.getElementById("sale-company-select");
  if (!sel) return;
  sel.innerHTML = `<option value="">— Digitar empresa manualmente —</option>`;
  state.empresas.forEach((e) => {
    const opt = document.createElement("option");
    opt.value = e.id;
    opt.textContent = `${e.nomeFantasia || e.razaoSocial} (${e.cnpj})`;
    sel.appendChild(opt);
  });
}
window.onSaleCompanySelectChange = function () {
  const emp = state.empresas.find((e) => e.id === document.getElementById("sale-company-select")?.value);
  if (!emp) return;
  document.getElementById("sale-company-name").value = emp.nomeFantasia || emp.razaoSocial;
  document.getElementById("sale-company-cnpj").value = emp.cnpj || "";
};
function populateAdminSaleSellerSelect() {
  const sel = document.getElementById("sale-seller-select");
  if (!sel) return;
  sel.innerHTML = `<option value="${ADMIN_EMAIL}">João Pedro (Diretor / Admin)</option>`;
  state.funcionarios.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.email.toLowerCase();
    opt.textContent = `${f.nome} (${f.comissaoPercent ?? 10}%)`;
    sel.appendChild(opt);
  });
}

window.handleRegisterEmployeeSale = async function (e) {
  e.preventDefault();
  const isAdmin = state.role === "admin";
  let vendedorEmail = (state.user.email || "").toLowerCase();
  let vendedorNome = state.staffProfile?.nome || vendedorEmail;
  let comissaoPercent = Number(state.staffProfile?.comissaoPercent ?? 10);
  if (isAdmin) {
    vendedorEmail = (document.getElementById("sale-seller-select")?.value || ADMIN_EMAIL).toLowerCase();
    const st = state.funcionarios.find((f) => f.email.toLowerCase() === vendedorEmail);
    vendedorNome = st ? st.nome : "João Pedro (Admin)";
    comissaoPercent = st ? Number(st.comissaoPercent ?? 10) : 0;
  }
  const empresaUid = document.getElementById("sale-company-select")?.value || "";
  const empresaNome = document.getElementById("sale-company-name").value.trim();
  const empresaCnpj = document.getElementById("sale-company-cnpj").value.trim();
  const plan = getPlanById(document.getElementById("sale-plan-select").value);
  const comissaoValor = Math.round(((plan.valor * comissaoPercent) / 100) * 100) / 100;
  const now = Date.now();

  await addDoc(collection(db, "vendas_equipe"), {
    vendedorEmail,
    vendedorNome,
    empresaUid,
    empresaNome,
    empresaCnpj,
    planoTier: plan.id,
    planoNome: plan.nome,
    valor: plan.valor,
    comissaoPercent,
    comissaoValor,
    status: isAdmin ? "aprovada" : "pendente",
    observacoes: document.getElementById("sale-obs").value.trim(),
    competencia: currentMonthKey(),
    createdAt: now,
    approvedAt: isAdmin ? now : null
  });
  if (isAdmin) {
    await addDoc(collection(db, "financeiro"), {
      tipo: "entrada",
      categoria: "Assinatura Premium",
      descricao: `Venda ${plan.nome} (${vendedorNome}) — ${empresaNome}`,
      valor: plan.valor,
      status: "pago",
      empresaUid,
      empresaNome,
      empresaCnpj,
      planoTier: plan.id,
      vendedorEmail,
      vendedorNome,
      metodo: "Pix",
      competencia: currentMonthKey(),
      createdAt: now,
      paidAt: now
    });
    if (empresaUid) await window.adminActivateCompanyPremium(empresaUid, false, plan.id);
  }
  document.getElementById("form-register-sale").reset();
  window.showToast(isAdmin ? "Venda registrada e lançada no Financeiro!" : "Venda registrada! Aguardando aprovação.");
};

function renderSalesDashboard() {
  const isAdmin = state.role === "admin";
  const monthKey = currentMonthKey();
  const approved = state.vendasEquipe.filter((v) => v.status === "aprovada");
  const pending = state.vendasEquipe.filter((v) => v.status === "pendente");
  const monthSales = approved.filter((v) => (v.competencia || "").startsWith(monthKey));
  const totalVal = monthSales.reduce((a, v) => a + (Number(v.valor) || 0), 0);
  const totalComm = monthSales.reduce((a, v) => a + (Number(v.comissaoValor) || 0), 0);

  document.getElementById("sales-kpi-count").textContent = `${monthSales.length} plano(s)`;
  document.getElementById("sales-kpi-total").textContent = formatMoney(totalVal);
  document.getElementById("sales-kpi-comm").textContent = formatMoney(totalComm);
  document.getElementById("sales-kpi-pending").textContent = `${pending.length} pendente(s)`;

  const goalBox = document.getElementById("staff-goal-box");
  if (goalBox) {
    if (!isAdmin && Number(state.staffProfile?.metaMensal) > 0) {
      const meta = Number(state.staffProfile.metaMensal);
      const pct = Math.min(100, Math.round((totalVal / meta) * 100));
      goalBox.classList.remove("hidden");
      document.getElementById("staff-goal-text").textContent = `${formatMoney(totalVal)} de ${formatMoney(meta)} (${pct}%)`;
      document.getElementById("staff-goal-bar").style.width = `${pct}%`;
    } else goalBox.classList.add("hidden");
  }

  const rankingBox = document.getElementById("admin-sales-ranking");
  if (rankingBox && isAdmin) {
    const map = new Map();
    state.funcionarios.forEach((f) => map.set(f.email.toLowerCase(), { nome: f.nome, fotoUrl: f.fotoUrl || "", comissaoPercent: Number(f.comissaoPercent ?? 10), qtd: 0, total: 0, comissao: 0 }));
    approved.forEach((v) => {
      const k = (v.vendedorEmail || "").toLowerCase();
      if (!map.has(k)) map.set(k, { nome: v.vendedorNome || k, fotoUrl: "", comissaoPercent: v.comissaoPercent || 0, qtd: 0, total: 0, comissao: 0 });
      const r = map.get(k);
      r.qtd += 1;
      r.total += Number(v.valor) || 0;
      r.comissao += Number(v.comissaoValor) || 0;
    });
    const ranked = Array.from(map.values()).sort((a, b) => b.total - a.total);
    rankingBox.innerHTML = ranked.length
      ? ranked
          .map((r, i) => `<div class="bg-brand-black border border-brand-border rounded-xl p-3 flex justify-between items-center gap-3"><div class="flex items-center gap-3"><span class="w-7 h-7 rounded-lg ${i === 0 && r.total > 0 ? "bg-brand-yellow text-brand-black" : "bg-brand-card text-neutral-400"} font-extrabold text-xs flex items-center justify-center">#${i + 1}</span><div><strong class="text-white text-sm block">${esc(r.nome)}</strong><span class="text-[11px] text-neutral-400">${r.qtd} venda(s) • Comissão ${r.comissaoPercent}%</span></div></div><div class="text-right"><strong class="text-brand-yellow font-extrabold block">${formatMoney(r.total)}</strong><span class="text-[11px] text-emerald-400">Com.: ${formatMoney(r.comissao)}</span></div></div>`)
          .join("")
      : `<p class="text-xs text-neutral-500">Nenhuma venda contabilizada ainda.</p>`;
  }

  const tbody = document.getElementById("sales-ledger-tbody");
  if (!tbody) return;
  tbody.innerHTML = state.vendasEquipe.length
    ? state.vendasEquipe
        .map(
          (v) => `
          <tr class="hover:bg-brand-black/40">
            <td class="py-2.5 px-3 text-xs text-neutral-400">${formatDate(v.createdAt)}</td>
            <td class="py-2.5 px-3"><strong class="text-white text-xs block">${esc(v.vendedorNome)}</strong><span class="text-[11px] text-neutral-400">${esc(v.empresaNome)}</span></td>
            <td class="py-2.5 px-3 text-xs text-brand-yellow font-bold">${esc(v.planoNome)}</td>
            <td class="py-2.5 px-3 text-xs"><strong class="text-white block">${formatMoney(v.valor)}</strong><span class="text-emerald-400 text-[11px]">Com.: ${formatMoney(v.comissaoValor)}</span></td>
            <td class="py-2.5 px-3"><span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${v.status === "aprovada" ? "bg-emerald-500/20 text-emerald-400" : v.status === "pendente" ? "bg-amber-500/20 text-amber-300" : "bg-red-500/20 text-red-400"}">${esc(v.status)}</span></td>
            <td class="py-2.5 px-3 text-right">${isAdmin ? `${v.status === "pendente" ? `<button type="button" onclick="adminApproveSale('${esc(v.id)}')" class="px-2.5 py-1 rounded bg-emerald-500 text-brand-black font-bold text-xs mr-1">Aprovar</button>` : ""}<button type="button" onclick="adminDeleteSale('${esc(v.id)}')" class="p-1.5 rounded bg-brand-black border border-brand-border text-neutral-400 hover:text-red-400"><i class="fa-solid fa-trash text-xs"></i></button>` : "—"}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="py-6 text-center text-neutral-500 text-xs">Nenhuma venda registrada.</td></tr>`;
}

window.adminApproveSale = async function (saleId) {
  const sale = state.vendasEquipe.find((v) => v.id === saleId);
  if (!sale) return;
  const now = Date.now();
  await updateDoc(doc(db, "vendas_equipe", saleId), { status: "aprovada", approvedAt: now });
  await addDoc(collection(db, "financeiro"), {
    tipo: "entrada",
    categoria: "Assinatura Premium",
    descricao: `Venda ${sale.planoNome} (${sale.vendedorNome}) — ${sale.empresaNome}`,
    valor: Number(sale.valor),
    status: "pago",
    empresaUid: sale.empresaUid || "",
    empresaNome: sale.empresaNome,
    empresaCnpj: sale.empresaCnpj || "",
    planoTier: sale.planoTier,
    vendedorEmail: sale.vendedorEmail,
    vendedorNome: sale.vendedorNome,
    metodo: "Pix",
    competencia: currentMonthKey(),
    createdAt: now,
    paidAt: now
  });
  if (sale.empresaUid) await window.adminActivateCompanyPremium(sale.empresaUid, false, sale.planoTier);
  window.showToast("Venda aprovada e contabilizada!");
};
window.adminDeleteSale = async function (id) {
  await deleteDoc(doc(db, "vendas_equipe", id));
  window.showToast("Venda excluída.");
};

// ============================================================================
// ADMIN/STAFF CURRÍCULOS + VIP TOGGLE
// ============================================================================
function renderAdminTalentsTable() {
  const tbody = document.getElementById("admin-talents-tbody");
  if (!tbody) return;
  if (!state.talents.length) return (tbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-neutral-500 text-xs">Banco de currículos limpo.</td></tr>`);
  tbody.innerHTML = state.talents
    .map((cand) => {
      const priv = state.privateContacts.get(cand.id);
      const phone = priv?.whatsapp || "";
      const clean = phone.replace(/\D/g, "");
      const isVip = cand.planoCandidato === "vip" || cand.destaque;
      return `
        <tr class="hover:bg-brand-black/40">
          <td class="py-3 px-3"><span class="text-xs font-mono text-brand-yellow font-bold">${esc(cand.codigo)}</span> ${isVip ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-brand-yellow text-brand-black font-extrabold">VIP R$20</span>` : ""}<strong class="text-white block">${esc(priv?.nomeCompleto || cand.nomeProtegido)}</strong></td>
          <td class="py-3 px-3 text-xs"><span class="text-white block">${esc(cand.cargo)}</span><span class="text-neutral-400">${esc(cand.area)}</span></td>
          <td class="py-3 px-3 text-xs">${clean ? `<a href="https://wa.me/55${clean}" target="_blank" class="text-emerald-400 hover:underline"><i class="fa-brands fa-whatsapp mr-1"></i>${esc(phone)}</a>` : "—"}</td>
          <td class="py-3 px-3 text-xs">${cand.notaMedia != null ? `<span class="text-emerald-400 font-bold">${Number(cand.notaMedia).toFixed(1)}/10</span>` : `<span class="text-neutral-400">Aguardando</span>`}</td>
          <td class="py-3 px-3 text-right">
            <div class="inline-flex items-center gap-1.5">
              <button type="button" onclick="startPedroxForCandidate('${esc(cand.id)}')" class="px-2.5 py-1.5 rounded-lg bg-brand-yellow text-brand-black font-bold text-xs">Pedrox</button>
              <button type="button" onclick="toggleHighlightTalent('${esc(cand.id)}', ${!isVip})" title="Ativar/Desativar VIP Topo" class="p-2 rounded-lg bg-brand-black border border-brand-border ${isVip ? "text-brand-yellow" : "text-neutral-400"}"><i class="fa-solid fa-crown text-xs"></i></button>
              <button type="button" onclick="deleteTalent('${esc(cand.id)}')" class="p-2 rounded-lg bg-brand-black border border-brand-border text-neutral-400 hover:text-red-400"><i class="fa-solid fa-trash text-xs"></i></button>
            </div>
          </td>
        </tr>`;
    })
    .join("");
}

window.toggleHighlightTalent = async function (id, status) {
  await updateDoc(doc(db, "candidatos", id), { destaque: status, planoCandidato: status ? "vip" : "gratuito", verificado: status });
  window.showToast(status ? "Candidato promovido para Destaque VIP no topo!" : "Destaque VIP removido.");
};
window.deleteTalent = async function (id) {
  await deleteDoc(doc(db, "candidatos", id));
  await deleteDoc(doc(db, "candidatos_privado", id)).catch(() => {});
  window.showToast("Currículo excluído.");
};

// ============================================================================
// ADMIN: EMPRESAS & FINANCEIRO (INCLUINDO APROVAÇÃO CANDIDATO VIP R$ 20!)
// ============================================================================
function renderAdminCompaniesTable() {
  const tbody = document.getElementById("admin-companies-tbody");
  if (!tbody) return;
  if (!state.empresas.length) return (tbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-neutral-500 text-xs">Nenhuma empresa cadastrada.</td></tr>`);
  tbody.innerHTML = state.empresas
    .map((emp) => {
      const isPrem = isCompanyPremiumActive(emp);
      const tier = getPlanById(emp.planoTier || emp.planoSolicitado || "start");
      return `
        <tr class="hover:bg-brand-black/40">
          <td class="py-3 px-3"><strong class="text-white block">${esc(emp.nomeFantasia || emp.razaoSocial)}</strong><span class="text-xs font-mono text-brand-yellow">${esc(emp.cnpj)}</span></td>
          <td class="py-3 px-3 text-xs text-neutral-300">${esc(emp.responsavel)}<span class="block text-neutral-500">${esc(emp.email)}</span></td>
          <td class="py-3 px-3 text-xs">${isPrem ? `<span class="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-bold">${esc(tier.nome)}</span>` : `<span class="px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400">${esc(emp.plano)}</span>`}</td>
          <td class="py-3 px-3 text-xs text-neutral-300">${emp.premiumAte ? formatDate(emp.premiumAte) : "—"}</td>
          <td class="py-3 px-3 text-right">
            <div class="inline-flex flex-wrap gap-1.5 justify-end">
              <select id="admin-tier-sel-${esc(emp.id)}" class="px-2 py-1 rounded bg-brand-black border border-brand-border text-[11px] text-white">
                ${COMPANY_PLANS.map((p) => `<option value="${p.id}" ${(emp.planoTier || emp.planoSolicitado || "start") === p.id ? "selected" : ""}>${p.nome} (R$${p.valor})</option>`).join("")}
              </select>
              <button type="button" onclick="adminActivateCompanyWithSelect('${esc(emp.id)}')" class="px-2.5 py-1 rounded bg-brand-yellow text-brand-black font-extrabold text-xs">Ativar 30d</button>
              ${isPrem ? `<button type="button" onclick="adminRevokeCompanyPremium('${esc(emp.id)}')" class="px-2 py-1 rounded bg-brand-black border border-brand-border text-red-400 text-xs">Suspender</button>` : ""}
            </div>
          </td>
        </tr>`;
    })
    .join("");
}

window.adminActivateCompanyWithSelect = function (empUid) {
  window.adminActivateCompanyPremium(empUid, true, document.getElementById(`admin-tier-sel-${empUid}`)?.value || "start");
};

window.adminActivateCompanyPremium = async function (empUid, recordFinance = true, tierId = null) {
  const emp = state.empresas.find((e) => e.id === empUid);
  if (!emp) return;
  const plan = getPlanById(tierId || emp.planoSolicitado || emp.planoTier || "start");
  const now = Date.now();
  const baseTime = emp.premiumAte && emp.premiumAte > now ? emp.premiumAte : now;
  const newExpiry = baseTime + 30 * 24 * 60 * 60 * 1000;
  await updateDoc(doc(db, "empresas", empUid), { plano: "premium", planoTier: plan.id, planoValor: plan.valor, premiumAte: newExpiry, emTeste: false, updatedAt: now });
  if (recordFinance) {
    const pendingTx = state.financeiro.find((t) => t.empresaUid === empUid && t.status === "pendente");
    if (pendingTx) await updateDoc(doc(db, "financeiro", pendingTx.id), { status: "pago", paidAt: now, planoTier: plan.id, valor: plan.valor });
    else
      await addDoc(collection(db, "financeiro"), {
        tipo: "entrada",
        categoria: "Assinatura Premium",
        descricao: `${plan.nome} 30d — ${emp.nomeFantasia || emp.razaoSocial}`,
        valor: plan.valor,
        status: "pago",
        empresaUid: empUid,
        empresaNome: emp.nomeFantasia || emp.razaoSocial,
        empresaCnpj: emp.cnpj,
        planoTier: plan.id,
        vendedorEmail: emp.vendedorEmail || "",
        vendedorNome: emp.vendedorNome || "",
        metodo: "Pix",
        competencia: currentMonthKey(),
        createdAt: now,
        paidAt: now
      });
  }
  window.showToast(`${plan.nome} ativado até ${formatDate(newExpiry)}!`);
};

window.adminRevokeCompanyPremium = async function (empUid) {
  await updateDoc(doc(db, "empresas", empUid), { plano: "gratuito", planoTier: "gratuito", premiumAte: null, updatedAt: Date.now() });
  window.showToast("Plano suspenso.");
};

function renderAdminFinanceDashboard() {
  if (state.role !== "admin") return;
  const monthKey = currentMonthKey();
  const paidIn = state.financeiro.filter((t) => t.tipo === "entrada" && t.status === "pago");
  const paidOut = state.financeiro.filter((t) => t.tipo === "saida" && t.status === "pago");
  const pendingIn = state.financeiro.filter((t) => t.tipo === "entrada" && t.status === "pendente");

  document.getElementById("fin-kpi-month").textContent = formatMoney(paidIn.filter((t) => (t.competencia || "").startsWith(monthKey)).reduce((a, t) => a + (Number(t.valor) || 0), 0));
  document.getElementById("fin-kpi-pending").textContent = formatMoney(pendingIn.reduce((a, t) => a + (Number(t.valor) || 0), 0));
  const activeEmps = state.empresas.filter((e) => isCompanyPremiumActive(e));
  const mrr = activeEmps.reduce((a, e) => a + (Number(e.planoValor) || getPlanById(e.planoTier || "start").valor), 0);
  document.getElementById("fin-kpi-mrr").textContent = `${activeEmps.length} ativa(s) • ${formatMoney(mrr)}`;
  document.getElementById("fin-kpi-balance").textContent = formatMoney(paidIn.reduce((a, t) => a + (Number(t.valor) || 0), 0) - paidOut.reduce((a, t) => a + (Number(t.valor) || 0), 0));

  const pendingBox = document.getElementById("fin-pending-approvals");
  pendingBox.innerHTML = pendingIn.length
    ? pendingIn
        .map(
          (tx) => `
          <div class="bg-brand-black border border-amber-500/40 rounded-xl p-3.5 flex flex-wrap justify-between items-center gap-3">
            <div>
              <strong class="text-white text-sm block">${esc(tx.empresaNome || tx.descricao)}</strong>
              <span class="text-xs text-neutral-400">${esc(tx.categoria)}${tx.candidatoCodigo ? ` • Código ${esc(tx.candidatoCodigo)}` : ""}${tx.vendedorNome ? ` • Vendedor: ${esc(tx.vendedorNome)}` : ""} • ${formatDateTime(tx.createdAt)}</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="font-extrabold text-brand-yellow mr-1">${formatMoney(tx.valor)}</span>
              <button type="button" onclick="adminApproveFinanceTx('${esc(tx.id)}')" class="px-3 py-1.5 rounded-xl bg-emerald-500 text-brand-black font-extrabold text-xs">Aprovar & Liberar</button>
              <button type="button" onclick="adminCancelFinanceTx('${esc(tx.id)}')" class="px-2.5 py-1.5 rounded-xl bg-brand-card border border-brand-border text-neutral-400 text-xs">Recusar</button>
            </div>
          </div>`
        )
        .join("")
    : `<p class="text-xs text-neutral-500">Nenhum Pix pendente de aprovação.</p>`;

  const tbody = document.getElementById("fin-ledger-tbody");
  tbody.innerHTML = state.financeiro.length
    ? state.financeiro
        .map(
          (tx) => `
          <tr class="hover:bg-brand-black/40">
            <td class="py-2.5 px-3 text-xs text-neutral-400">${formatDate(tx.createdAt)}</td>
            <td class="py-2.5 px-3"><strong class="text-white text-xs block">${esc(tx.descricao)}</strong><span class="text-[11px] text-neutral-400">${esc(tx.categoria)} • ${esc(tx.metodo || "Pix")}</span></td>
            <td class="py-2.5 px-3 text-xs font-bold ${tx.tipo === "entrada" ? "text-emerald-400" : "text-red-400"}">${tx.tipo === "entrada" ? "+ Entrada" : "- Saída"}</td>
            <td class="py-2.5 px-3 font-bold text-sm text-white">${formatMoney(tx.valor)}</td>
            <td class="py-2.5 px-3"><span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${tx.status === "pago" ? "bg-emerald-500/20 text-emerald-400" : tx.status === "pendente" ? "bg-amber-500/20 text-amber-300" : "bg-red-500/20 text-red-400"}">${esc(tx.status)}</span></td>
            <td class="py-2.5 px-3 text-right">${tx.status === "pendente" ? `<button type="button" onclick="adminApproveFinanceTx('${esc(tx.id)}')" class="p-1.5 rounded bg-emerald-500/20 text-emerald-400 mr-1"><i class="fa-solid fa-check text-xs"></i></button>` : ""}<button type="button" onclick="adminDeleteFinanceTx('${esc(tx.id)}')" class="p-1.5 rounded bg-brand-black border border-brand-border text-neutral-400 hover:text-red-400"><i class="fa-solid fa-trash text-xs"></i></button></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="py-6 text-center text-neutral-500 text-xs">Nenhum lançamento financeiro.</td></tr>`;
}

window.adminApproveFinanceTx = async function (txId) {
  const tx = state.financeiro.find((t) => t.id === txId);
  if (!tx) return;
  const now = Date.now();
  await updateDoc(doc(db, "financeiro", txId), { status: "pago", paidAt: now });

  if (tx.empresaUid) {
    await window.adminActivateCompanyPremium(tx.empresaUid, false, tx.planoTier || "start");
  }
  if (tx.candidatoId) {
    await updateDoc(doc(db, "candidatos", tx.candidatoId), { destaque: true, planoCandidato: "vip", verificado: true }).catch(() => {});
  }
  if (tx.vendedorNome) {
    const matched = state.funcionarios.find((f) => f.nome.toLowerCase() === tx.vendedorNome.toLowerCase());
    if (matched) {
      const plan = getPlanById(tx.planoTier || "start");
      const commPct = Number(matched.comissaoPercent ?? 10);
      await addDoc(collection(db, "vendas_equipe"), {
        vendedorEmail: matched.email.toLowerCase(),
        vendedorNome: matched.nome,
        empresaUid: tx.empresaUid || "",
        empresaNome: tx.empresaNome || tx.descricao,
        empresaCnpj: tx.empresaCnpj || "",
        planoTier: plan.id,
        planoNome: plan.nome,
        valor: Number(tx.valor),
        comissaoPercent: commPct,
        comissaoValor: Math.round(((Number(tx.valor) * commPct) / 100) * 100) / 100,
        status: "aprovada",
        observacoes: "Crédito automático via aprovação Pix",
        competencia: currentMonthKey(),
        createdAt: now,
        approvedAt: now
      });
    }
  }
  window.showToast(tx.candidatoId ? "Pix R$ 20 aprovado! Candidato promovido para Destaque VIP no topo!" : "Pagamento aprovado e plano liberado!");
};

window.adminCancelFinanceTx = async function (txId) {
  const tx = state.financeiro.find((t) => t.id === txId);
  await updateDoc(doc(db, "financeiro", txId), { status: "cancelado" });
  if (tx?.empresaUid) await updateDoc(doc(db, "empresas", tx.empresaUid), { plano: "gratuito", updatedAt: Date.now() }).catch(() => {});
  window.showToast("Cancelado.");
};
window.adminDeleteFinanceTx = async function (txId) {
  await deleteDoc(doc(db, "financeiro", txId));
  window.showToast("Lançamento excluído.");
};

window.handleAdminAddFinanceTx = async function (e) {
  e.preventDefault();
  const now = Date.now();
  const status = document.getElementById("fin-new-status").value;
  await addDoc(collection(db, "financeiro"), {
    tipo: document.getElementById("fin-new-tipo").value,
    categoria: document.getElementById("fin-new-categoria").value,
    descricao: document.getElementById("fin-new-descricao").value.trim(),
    valor: Number(document.getElementById("fin-new-valor").value),
    status,
    empresaUid: "",
    empresaNome: "",
    empresaCnpj: "",
    planoTier: "",
    vendedorEmail: "",
    vendedorNome: "",
    metodo: document.getElementById("fin-new-metodo").value,
    competencia: currentMonthKey(),
    createdAt: now,
    paidAt: status === "pago" ? now : null
  });
  document.getElementById("form-fin-new").reset();
  window.showToast("Lançamento adicionado!");
};

window.handleSavePixConfig = async function (e) {
  e.preventDefault();
  await setDoc(doc(db, "configuracoes", "financeiro"), {
    chavePix: document.getElementById("cfg-pix-key").value.trim(),
    titularPix: document.getElementById("cfg-pix-holder").value.trim(),
    bancoPix: document.getElementById("cfg-pix-bank").value.trim() || "Pix JP RH",
    valorPremium: 50,
    whatsappFinanceiro: WHATSAPP_JPRH,
    linkCartaoCandVip: (document.getElementById("cfg-card-cand-vip")?.value || "").trim(),
    linkCartaoStart: (document.getElementById("cfg-card-start")?.value || "").trim(),
    linkCartaoImpulso: (document.getElementById("cfg-card-impulso")?.value || "").trim(),
    linkCartaoLider: (document.getElementById("cfg-card-lider")?.value || "").trim(),
    linkCartaoVip: (document.getElementById("cfg-card-vip")?.value || "").trim(),
    updatedAt: Date.now()
  });
  window.showToast("Chave Pix, QR Code e Links de Cartão atualizados no site!");
};

// ============================================================================
// ABA DIRETORIA: ADICIONAR E TIRAR ACESSO DE FUNCIONÁRIOS + FOTOS VITRINE
// ============================================================================
window.handleStaffPhotoUpload = async function (inputEl, target) {
  const file = inputEl.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await compressImageFile(file, 320, 0.78);
    if (target === "staff") {
      state.staffPhotoDraft = dataUrl;
      const p = document.getElementById("staff-photo-preview");
      if (p) { p.src = dataUrl; p.classList.remove("hidden"); }
    } else {
      state.vitrinePhotoDraft = dataUrl;
      const p = document.getElementById("vitrine-photo-preview");
      if (p) { p.src = dataUrl; p.classList.remove("hidden"); }
    }
    window.showToast("Foto otimizada e pronta!");
  } catch (err) {
    window.showToast(err.message || "Erro na foto.", "error");
  }
};

window.handleAdminAddStaff = async function (e) {
  e.preventDefault();
  const nome = document.getElementById("staff-new-nome").value.trim();
  const email = document.getElementById("staff-new-email").value.trim().toLowerCase();
  const cargo = document.getElementById("staff-new-cargo").value.trim() || "Consultor de RH";
  const nivel = state.role === "admin" ? document.getElementById("staff-new-nivel")?.value || "funcionario" : "funcionario";
  const telefone = document.getElementById("staff-new-telefone").value.trim();
  const comissaoPercent = Number(document.getElementById("staff-new-comissao").value || 10);
  const metaMensal = Number(document.getElementById("staff-new-meta").value || 1000);
  const bio = document.getElementById("staff-new-bio").value.trim();
  const showVitrine = document.getElementById("staff-new-vitrine")?.checked && state.role === "admin";
  const now = Date.now();

  try {
    await setDoc(doc(db, "funcionarios", email), {
      email,
      nome,
      cargo,
      nivel,
      telefone,
      fotoUrl: state.staffPhotoDraft || "",
      comissaoPercent,
      metaMensal,
      ativo: true,
      createdAt: now,
      createdBy: state.user.email.toLowerCase()
    });
    if (showVitrine) {
      const slug = email.replace(/[^a-z0-9]/g, "_");
      await setDoc(doc(db, "equipe_vitrine", `staff_${slug}`), {
        nome,
        cargo,
        bio: bio || "Especialista JP RH em entrevistas, atendimento e gestão de talentos.",
        fotoUrl: state.staffPhotoDraft || "",
        ativo: true,
        ordem: 20,
        destaque: nivel === "diretor",
        createdAt: now
      });
    }
    document.getElementById("form-staff-new").reset();
    state.staffPhotoDraft = "";
    document.getElementById("staff-photo-preview")?.classList.add("hidden");
    window.showToast(`Acesso concedido para ${nome} (${nivel === "diretor" ? "Diretor" : "Funcionário"})!`);
  } catch (err) {
    console.error(err);
    window.showToast("Erro ao adicionar funcionário.", "error");
  }
};

function renderDirectorAccessPanel() {
  const tbody = document.getElementById("admin-staff-tbody");
  if (!tbody) return;
  const ativos = state.funcionarios.filter((f) => f.ativo).length;
  const revogados = state.funcionarios.filter((f) => !f.ativo).length;
  const elTotal = document.getElementById("dir-kpi-total");
  const elAtivos = document.getElementById("dir-kpi-ativos");
  const elRev = document.getElementById("dir-kpi-revogados");
  if (elTotal) elTotal.textContent = state.funcionarios.length;
  if (elAtivos) elAtivos.textContent = ativos;
  if (elRev) elRev.textContent = revogados;

  if (!state.funcionarios.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="py-6 text-center text-neutral-500 text-xs">Nenhum funcionário cadastrado.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.funcionarios
    .map(
      (f) => `
      <tr class="hover:bg-brand-black/40">
        <td class="py-3 px-3">
          <div class="flex items-center gap-3">
            ${f.fotoUrl ? `<img src="${esc(f.fotoUrl)}" class="w-10 h-10 rounded-xl object-cover border border-brand-border">` : `<div class="w-10 h-10 rounded-xl bg-brand-card border border-brand-border flex items-center justify-center text-brand-yellow font-bold text-xs">${esc(f.nome.substring(0, 2).toUpperCase())}</div>`}
            <div>
              <strong class="text-white text-sm">${esc(f.nome)}</strong>
              ${f.nivel === "diretor" ? `<span class="text-[10px] font-extrabold px-1.5 py-0.5 rounded bg-brand-yellow text-brand-black ml-1">DIRETOR</span>` : ""}
              <span class="text-xs text-neutral-400 block">${esc(f.email)}</span>
            </div>
          </div>
        </td>
        <td class="py-3 px-3 text-xs text-neutral-300"><span class="block">${esc(f.cargo)}</span><span class="text-brand-yellow text-[11px]">Com.: ${f.comissaoPercent ?? 10}% • Meta: ${formatMoney(f.metaMensal ?? 0)}</span></td>
        <td class="py-3 px-3"><span class="text-[10px] font-extrabold px-2.5 py-1 rounded-full ${f.ativo ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}">${f.ativo ? "Acesso Ativo" : "Acesso Tirado / Bloqueado"}</span></td>
        <td class="py-3 px-3 text-right">
          <div class="inline-flex items-center gap-1.5">
            <button type="button" onclick="toggleStaffActive('${esc(f.id)}', ${!f.ativo})"
                    class="px-3 py-1.5 rounded-lg font-bold text-xs ${f.ativo ? "bg-red-500/20 text-red-300 border border-red-500/40 hover:bg-red-500 hover:text-white" : "bg-emerald-500 text-brand-black"}">
              ${f.ativo ? "Tirar Acesso" : "Liberar Acesso"}
            </button>
            <button type="button" onclick="deleteStaffMember('${esc(f.id)}')" class="p-1.5 rounded-lg bg-brand-black border border-brand-border text-neutral-400 hover:text-red-400"><i class="fa-solid fa-trash text-xs"></i></button>
          </div>
        </td>
      </tr>`
    )
    .join("");
}

window.toggleStaffActive = async function (emailId, ativo) {
  await updateDoc(doc(db, "funcionarios", emailId), { ativo });
  window.showToast(ativo ? "Acesso do funcionário liberado!" : "Acesso do funcionário revogado imediatamente!");
};
window.deleteStaffMember = async function (emailId) {
  await deleteDoc(doc(db, "funcionarios", emailId));
  window.showToast("Funcionário removido.");
};

window.handleAdminAddVitrineMember = async function (e) {
  e.preventDefault();
  await addDoc(collection(db, "equipe_vitrine"), {
    nome: document.getElementById("vitrine-nome").value.trim(),
    cargo: document.getElementById("vitrine-cargo").value.trim(),
    bio: document.getElementById("vitrine-bio").value.trim(),
    fotoUrl: state.vitrinePhotoDraft || "",
    ativo: true,
    ordem: Number(document.getElementById("vitrine-ordem").value || 10),
    destaque: document.getElementById("vitrine-destaque").checked,
    createdAt: Date.now()
  });
  document.getElementById("form-vitrine-new").reset();
  state.vitrinePhotoDraft = "";
  document.getElementById("vitrine-photo-preview")?.classList.add("hidden");
  window.showToast("Foto publicada na seção Nossa Equipe!");
};

function renderAdminVitrineTable() {
  const box = document.getElementById("admin-vitrine-list");
  if (!box) return;
  box.innerHTML = state.equipeVitrine.length
    ? state.equipeVitrine
        .map((m) => `<div class="bg-brand-black border border-brand-border rounded-xl p-3 flex items-center justify-between gap-3"><div class="flex items-center gap-3">${m.fotoUrl ? `<img src="${esc(m.fotoUrl)}" class="w-11 h-11 rounded-xl object-cover border border-brand-yellow/40">` : `<div class="w-11 h-11 rounded-xl bg-brand-card flex items-center justify-center text-brand-yellow font-bold text-xs">${esc((m.nome || "JP").substring(0, 2).toUpperCase())}</div>`}<div><strong class="text-white text-sm block">${esc(m.nome)}</strong><span class="text-xs text-neutral-400">${esc(m.cargo)}</span></div></div><button type="button" onclick="deleteVitrineMember('${esc(m.id)}')" class="p-2 rounded-lg bg-brand-card border border-brand-border text-neutral-400 hover:text-red-400"><i class="fa-solid fa-trash text-xs"></i></button></div>`)
        .join("")
    : `<p class="text-xs text-neutral-500">Nenhuma foto publicada ainda.</p>`;
}
window.deleteVitrineMember = async function (id) {
  await deleteDoc(doc(db, "equipe_vitrine", id));
  window.showToast("Foto removida da vitrine.");
};

// ============================================================================
// CENTRAL DE SENHAS DE CLIENTES E FUNCIONÁRIOS (ADMIN & DIRETORIA)
// ============================================================================
let securityAccountsFilter = "todos";

window.setSecurityAccountsFilter = function (filter) {
  securityAccountsFilter = filter;
  ["todos", "funcionarios", "clientes"].forEach((f) => {
    const btn = document.getElementById(`sec-filter-${f}`);
    if (!btn) return;
    btn.className = f === filter
      ? "px-3 py-2 rounded-xl text-xs font-extrabold bg-brand-yellow text-brand-black"
      : "px-3 py-2 rounded-xl text-xs font-semibold bg-brand-card border border-brand-border text-neutral-300";
  });
  window.renderSecurityAccountsManager();
};

window.renderSecurityAccountsManager = function () {
  const tbody = document.getElementById("sec-accounts-tbody");
  if (!tbody || !isDirectorRole()) return;

  const q = (document.getElementById("sec-accounts-search")?.value || "").trim().toLowerCase();
  const rows = [];

  if (securityAccountsFilter === "todos" || securityAccountsFilter === "funcionarios") {
    state.funcionarios.forEach((f) => {
      rows.push({
        type: "funcionario",
        docId: f.id,
        nome: f.nome || "Funcionário",
        sub: f.cargo || (f.nivel === "diretor" ? "Diretor" : "Equipe JP RH"),
        email: f.email || f.id,
        telefone: f.telefone || "",
        exigirTroca: f.exigirTrocaSenha === true,
        ultimoReset: f.ultimoResetEnviadoEm || null
      });
    });
  }

  if (securityAccountsFilter === "todos" || securityAccountsFilter === "clientes") {
    state.empresas.forEach((emp) => {
      rows.push({
        type: "cliente",
        docId: emp.id,
        nome: emp.nomeFantasia || emp.razaoSocial || "Empresa",
        sub: emp.cnpj || emp.responsavel || "Cliente",
        email: emp.email || "",
        telefone: emp.whatsapp || "",
        exigirTroca: emp.exigirTrocaSenha === true,
        ultimoReset: emp.ultimoResetEnviadoEm || null
      });
    });
  }

  const filtered = rows.filter((r) => {
    if (!q) return true;
    return `${r.nome} ${r.sub} ${r.email} ${r.telefone}`.toLowerCase().includes(q);
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-neutral-500 text-xs">Nenhuma conta encontrada com esse filtro.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((r) => {
      const cleanPhone = String(r.telefone || "").replace(/\D/g, "");
      const waTarget = cleanPhone ? (cleanPhone.startsWith("55") ? cleanPhone : `55${cleanPhone}`) : "";
      const resetUrl = window.getResetPageUrl(r.email);
      const waMsg = `Olá *${r.nome}*! A Diretoria da *JP RH Eunápolis* liberou o link oficial para você redefinir sua senha com segurança:\n\n${resetUrl}\n\nVocê também pode trocar direto na aba *Entrar → Trocar Senha* no site.`;
      const waHref = waTarget
        ? `https://wa.me/${waTarget}?text=${encodeURIComponent(waMsg)}`
        : `https://wa.me/?text=${encodeURIComponent(waMsg)}`;
      const typeBadge = r.type === "funcionario"
        ? `<span class="px-2 py-0.5 rounded-full bg-brand-yellow/15 text-brand-yellow font-bold text-[10px]">Funcionário</span>`
        : `<span class="px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 font-bold text-[10px]">Cliente</span>`;
      const statusHtml = r.exigirTroca
        ? `<span class="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold text-[10px] block w-fit">Troca Obrigatória Ativa</span>`
        : `<span class="text-emerald-400 font-semibold text-[11px] block">Normal</span>`;
      const lastResetHtml = r.ultimoReset
        ? `<span class="text-[10px] text-neutral-500 block mt-0.5">Último envio: ${formatDate(r.ultimoReset)}</span>`
        : "";
      return `
        <tr class="hover:bg-brand-card/40">
          <td class="py-3 px-3">${typeBadge}</td>
          <td class="py-3 px-3"><strong class="text-white block">${esc(r.nome)}</strong><span class="text-[11px] text-neutral-400 font-mono">${esc(r.sub)}</span></td>
          <td class="py-3 px-3"><span class="text-neutral-200 block">${esc(r.email)}</span><span class="text-[11px] text-neutral-500">${esc(r.telefone || "Sem telefone")}</span></td>
          <td class="py-3 px-3">${statusHtml}${lastResetHtml}</td>
          <td class="py-3 px-3 text-right">
            <div class="inline-flex flex-wrap gap-1.5 justify-end">
              <button type="button" onclick="adminSendResetToAccount('${esc(r.type)}', '${esc(r.docId)}', '${esc(r.email)}', '${esc(r.nome)}')" class="px-2.5 py-1.5 rounded-lg bg-brand-yellow hover:bg-brand-yellowHover text-brand-black font-extrabold text-[11px]">
                <i class="fa-solid fa-envelope mr-1"></i>Enviar Link E-mail
              </button>
              <a href="${waHref}" target="_blank" rel="noopener noreferrer" class="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[11px]">
                <i class="fa-brands fa-whatsapp mr-1"></i>WhatsApp
              </a>
              <button type="button" onclick="adminToggleForcePasswordChange('${esc(r.type)}', '${esc(r.docId)}', ${!r.exigirTroca})" class="px-2.5 py-1.5 rounded-lg bg-brand-card border ${r.exigirTroca ? "border-emerald-500/40 text-emerald-300" : "border-amber-500/40 text-amber-300"} font-bold text-[11px]">
                <i class="fa-solid ${r.exigirTroca ? "fa-check" : "fa-lock"} mr-1"></i>${r.exigirTroca ? "Liberar Aviso" : "Exigir Troca"}
              </button>
            </div>
          </td>
        </tr>`;
    })
    .join("");
};

window.handleAdminSendCustomResetEmail = async function (e) {
  e.preventDefault();
  if (!isDirectorRole()) return;
  const input = document.getElementById("sec-custom-reset-email");
  const btn = document.getElementById("btn-sec-custom-reset");
  const email = (input?.value || "").trim().toLowerCase();
  if (!email) return;
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Enviando...`;
  try {
    await sendPasswordResetEmail(auth, email, getPasswordResetActionSettings());
    input.value = "";
    window.showToast(`Link/código oficial de redefinição enviado para ${email}!`);
  } catch (err) {
    window.showToast(mapAuthError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-paper-plane mr-1.5"></i>Enviar Redefinição Agora`;
  }
};

window.adminSendResetToAccount = async function (type, docId, email, name) {
  if (!isDirectorRole() || !email) return;
  try {
    await sendPasswordResetEmail(auth, email, getPasswordResetActionSettings());
    const colName = type === "funcionario" ? "funcionarios" : "empresas";
    const payload = type === "funcionario"
      ? { ultimoResetEnviadoEm: Date.now() }
      : { ultimoResetEnviadoEm: Date.now(), updatedAt: Date.now() };
    try { await updateDoc(doc(db, colName, docId), payload); } catch (_) {}
    window.showToast(`Link/código de troca de senha enviado para ${name} (${email})!`);
  } catch (err) {
    window.showToast(mapAuthError(err), "error");
  }
};

window.adminToggleForcePasswordChange = async function (type, docId, nextState) {
  if (!isDirectorRole()) return;
  try {
    const colName = type === "funcionario" ? "funcionarios" : "empresas";
    const payload = type === "funcionario"
      ? { exigirTrocaSenha: Boolean(nextState) }
      : { exigirTrocaSenha: Boolean(nextState), updatedAt: Date.now() };
    await updateDoc(doc(db, colName, docId), payload);
    window.showToast(nextState ? "Aviso de troca obrigatória ativado para esta conta!" : "Aviso de troca obrigatória removido.");
  } catch (err) {
    window.showToast(err?.message || "Erro ao atualizar flag de segurança.", "error");
  }
};

// ============================================================================
// ABA TESTE EXPERIMENTAL & CONTROLE DE PLANOS DAS EMPRESAS (DIRETORIA & ADMIN)
// ============================================================================
window.setTrialDaysPreset = function (days) {
  const input = document.getElementById("trial-days-input");
  if (input) input.value = String(days);
};

window.prefillTrialForm = function (empUid) {
  const emp = state.empresas.find((e) => e.id === empUid);
  if (!emp) return;
  const selComp = document.getElementById("trial-company-select");
  const selPlan = document.getElementById("trial-plan-select");
  const selMode = document.getElementById("trial-mode-select");
  const daysIn = document.getElementById("trial-days-input");
  const obsIn = document.getElementById("trial-obs-input");

  if (selComp) selComp.value = emp.id;
  if (selPlan) selPlan.value = emp.plano === "premium" ? (emp.planoTier || "start") : "vip";
  if (selMode) selMode.value = emp.emTeste ? "teste" : "pago";
  if (daysIn) daysIn.value = String(emp.testeDias || 7);
  if (obsIn) obsIn.value = emp.testeObs || "";
  selComp?.scrollIntoView({ behavior: "smooth", block: "center" });
  window.showToast(`Empresa "${emp.nomeFantasia || emp.razaoSocial}" carregada no configurador.`, "info");
};

window.handleApplyCompanyTrialOrPlan = async function (e) {
  e.preventDefault();
  if (!isDirectorRole()) return window.showToast("Acesso exclusivo da Diretoria e Admin.", "error");

  const empUid = document.getElementById("trial-company-select")?.value;
  const planId = document.getElementById("trial-plan-select")?.value || "vip";
  const mode = document.getElementById("trial-mode-select")?.value || "teste";
  const days = Math.max(1, Math.min(365, parseInt(document.getElementById("trial-days-input")?.value || "7", 10) || 7));
  const obs = (document.getElementById("trial-obs-input")?.value || "").trim().slice(0, 250);

  if (!empUid) return window.showToast("Selecione uma empresa primeiro.", "error");
  const emp = state.empresas.find((item) => item.id === empUid);
  if (!emp) return window.showToast("Empresa não encontrada.", "error");

  const btn = document.getElementById("btn-apply-trial");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Aplicando...`;

  try {
    const now = Date.now();
    if (planId === "gratuito") {
      await updateDoc(doc(db, "empresas", empUid), {
        plano: "gratuito",
        planoTier: "gratuito",
        planoValor: 0,
        premiumAte: null,
        emTeste: false,
        testeDias: null,
        testeInicio: null,
        testeObs: obs || null,
        updatedAt: now
      });
      window.showToast(`Plano removido: ${emp.nomeFantasia || emp.razaoSocial} voltou para Conta Gratuita.`);
    } else {
      const plan = getPlanById(planId);
      const isTrial = mode === "teste";
      const expiry = now + days * 24 * 60 * 60 * 1000;
      await updateDoc(doc(db, "empresas", empUid), {
        plano: "premium",
        planoTier: plan.id,
        planoValor: isTrial ? 0 : plan.valor,
        premiumAte: expiry,
        emTeste: isTrial,
        testeDias: isTrial ? days : null,
        testeInicio: isTrial ? now : null,
        testeObs: obs || (isTrial ? `Teste experimental de ${days} dia(s) no ${plan.nome}` : `Plano ${plan.nome} liberado por ${days} dia(s)`),
        updatedAt: now
      });
      window.showToast(
        isTrial
          ? `Período experimental de ${days} dia(s) no ${plan.nome} liberado para ${emp.nomeFantasia || emp.razaoSocial}!`
          : `${plan.nome} ativado por ${days} dia(s) para ${emp.nomeFantasia || emp.razaoSocial}!`
      );
    }
  } catch (err) {
    window.showToast(err?.message || "Erro ao aplicar período experimental/plano.", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-check mr-1.5"></i>Aplicar Período / Plano Agora`;
  }
};

window.quickExtendTrial = async function (empUid, extraDays = 7) {
  if (!isDirectorRole()) return;
  const emp = state.empresas.find((e) => e.id === empUid);
  if (!emp) return;
  const now = Date.now();
  const base = emp.premiumAte && Number(emp.premiumAte) > now ? Number(emp.premiumAte) : now;
  const newExpiry = base + extraDays * 24 * 60 * 60 * 1000;
  const plan = getPlanById(emp.planoTier || emp.planoSolicitado || "vip");
  const totalDays = Math.min(365, (Number(emp.testeDias) || 0) + extraDays);
  await updateDoc(doc(db, "empresas", empUid), {
    plano: "premium",
    planoTier: plan.id,
    planoValor: 0,
    premiumAte: newExpiry,
    emTeste: true,
    testeDias: totalDays,
    testeInicio: emp.testeInicio || now,
    updatedAt: now
  });
  window.showToast(`+${extraDays} dias de teste adicionados para ${emp.nomeFantasia || emp.razaoSocial}!`);
};

window.quickEndTrial = async function (empUid) {
  if (!isDirectorRole()) return;
  const emp = state.empresas.find((e) => e.id === empUid);
  if (!emp) return;
  await updateDoc(doc(db, "empresas", empUid), {
    plano: "gratuito",
    planoTier: "gratuito",
    planoValor: 0,
    premiumAte: null,
    emTeste: false,
    testeDias: null,
    testeInicio: null,
    updatedAt: Date.now()
  });
  window.showToast(`Período experimental encerrado para ${emp.nomeFantasia || emp.razaoSocial}.`);
};

window.renderTrialsAndPlansTab = function () {
  const tbody = document.getElementById("trial-companies-tbody");
  const select = document.getElementById("trial-company-select");
  if (!tbody || !isDirectorRole()) return;

  if (select) {
    const prev = select.value;
    select.innerHTML = state.empresas.length
      ? `<option value="">Selecione uma empresa...</option>` +
        state.empresas
          .map((emp) => `<option value="${esc(emp.id)}">${esc(emp.nomeFantasia || emp.razaoSocial)} (${esc(emp.cnpj)})</option>`)
          .join("")
      : `<option value="">Nenhuma empresa cadastrada ainda</option>`;
    if (prev && state.empresas.some((e) => e.id === prev)) select.value = prev;
  }

  const now = Date.now();
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  let kpiTrial = 0;
  let kpiPaid = 0;
  let kpiExpiring = 0;
  let kpiFree = 0;

  state.empresas.forEach((emp) => {
    const active = isCompanyPremiumActive(emp);
    if (active && emp.emTeste) {
      kpiTrial++;
      if (emp.premiumAte && Number(emp.premiumAte) - now <= threeDaysMs) kpiExpiring++;
    } else if (active) {
      kpiPaid++;
    } else {
      kpiFree++;
    }
  });

  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
  setTxt("trial-kpi-ativos", kpiTrial);
  setTxt("trial-kpi-pagos", kpiPaid);
  setTxt("trial-kpi-expirando", kpiExpiring);
  setTxt("trial-kpi-gratuito", kpiFree);

  const q = (document.getElementById("trial-list-search")?.value || "").trim().toLowerCase();
  const filtered = state.empresas.filter((emp) => {
    if (!q) return true;
    return `${emp.nomeFantasia || ""} ${emp.razaoSocial || ""} ${emp.cnpj || ""} ${emp.email || ""}`.toLowerCase().includes(q);
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-neutral-500 text-xs">Nenhuma empresa cadastrada para configurar período experimental.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((emp) => {
      const active = isCompanyPremiumActive(emp);
      const tier = getPlanById(emp.planoTier || emp.planoSolicitado || "start");
      const diffMs = emp.premiumAte ? Number(emp.premiumAte) - now : null;
      const daysLeft = diffMs !== null ? Math.ceil(diffMs / (24 * 60 * 60 * 1000)) : null;

      let modeBadge = `<span class="px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 font-semibold text-[10px]">Gratuito</span>`;
      if (active && emp.emTeste) {
        modeBadge = `<span class="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/40 font-bold text-[10px]"><i class="fa-solid fa-flask-vial mr-1"></i>Experimental (${emp.testeDias || daysLeft || 0}d)</span>`;
      } else if (active) {
        modeBadge = `<span class="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold text-[10px]"><i class="fa-solid fa-crown mr-1"></i>Plano Pago</span>`;
      } else if (emp.plano === "premium" && diffMs !== null && diffMs < 0) {
        modeBadge = `<span class="px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/40 font-bold text-[10px]">${emp.emTeste ? "Teste Expirado" : "Vencido"}</span>`;
      }

      const validityHtml = emp.premiumAte
        ? `<strong class="${daysLeft > 3 ? "text-white" : daysLeft >= 0 ? "text-brand-yellow" : "text-red-400"} block">${daysLeft >= 0 ? `${daysLeft} dia(s) restante(s)` : `Expirou há ${Math.abs(daysLeft)} dia(s)`}</strong><span class="text-[10px] text-neutral-400">Até ${formatDate(emp.premiumAte)}</span>`
        : `<span class="text-neutral-500">—</span>`;

      return `
        <tr class="hover:bg-brand-card/40">
          <td class="py-3 px-3">
            <strong class="text-white block">${esc(emp.nomeFantasia || emp.razaoSocial)}</strong>
            <span class="text-[11px] font-mono text-brand-yellow">${esc(emp.cnpj)}</span>
            ${emp.testeObs ? `<span class="block text-[10px] text-neutral-400 mt-0.5">${esc(emp.testeObs)}</span>` : ""}
          </td>
          <td class="py-3 px-3">
            ${active ? `<strong class="text-brand-yellow block">${esc(tier.nome)}</strong><span class="text-[10px] text-neutral-400">Ref. ${formatMoney(tier.valor)}/mês</span>` : `<span class="text-neutral-500">Sem plano ativo</span>`}
          </td>
          <td class="py-3 px-3">${modeBadge}</td>
          <td class="py-3 px-3">${validityHtml}</td>
          <td class="py-3 px-3 text-right">
            <div class="inline-flex flex-wrap gap-1.5 justify-end">
              <button type="button" onclick="prefillTrialForm('${esc(emp.id)}')" class="px-2.5 py-1.5 rounded-lg bg-brand-card border border-brand-border hover:border-brand-yellow text-neutral-200 font-bold text-[11px]"><i class="fa-solid fa-sliders mr-1"></i>Editar</button>
              <button type="button" onclick="quickExtendTrial('${esc(emp.id)}', 7)" class="px-2.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-bold text-[11px]">+7d Teste</button>
              ${active && emp.emTeste ? `<button type="button" onclick="quickEndTrial('${esc(emp.id)}')" class="px-2.5 py-1.5 rounded-lg bg-brand-card border border-red-500/40 text-red-400 hover:bg-red-500/10 font-bold text-[11px]">Encerrar</button>` : ""}
            </div>
          </td>
        </tr>`;
    })
    .join("");
};

// ============================================================================
// INIT
// ============================================================================
document.addEventListener("DOMContentLoaded", () => {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("mode") === "resetPassword" && urlParams.get("oobCode")) {
    window.location.replace(`./redefinir-senha/${window.location.search}`);
    return;
  }

  const secLinkEl = document.getElementById("sec-direct-reset-url");
  if (secLinkEl) secLinkEl.textContent = window.getResetPageUrl();

  document.getElementById("talent-search")?.addEventListener("input", window.renderTalents);
  document.getElementById("talent-filter-area")?.addEventListener("change", window.renderTalents);
  document.getElementById("talent-filter-disp")?.addEventListener("change", window.renderTalents);
  document.getElementById("talent-filter-bairro")?.addEventListener("change", window.renderTalents);
  document.getElementById("comp-reg-cnpj")?.addEventListener("input", (e) => { e.target.value = formatCnpj(e.target.value); });
  document.getElementById("sale-company-cnpj")?.addEventListener("input", (e) => { e.target.value = formatCnpj(e.target.value); });
  document.getElementById("comp-req-chip-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); window.addCompanyReqFromInput(); }
  });

  renderPublicPlansGrid();
  renderCompanyReqChips();
  renderHiringCompaniesSection();
  startPublicListeners();
});
