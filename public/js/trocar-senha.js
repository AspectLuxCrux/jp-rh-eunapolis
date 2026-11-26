import {
  auth,
  WHATSAPP_JPRH,
  getPasswordResetActionSettings,
  onAuthStateChanged,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  confirmPasswordReset,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword
} from "./firebase-init.js";

let currentUser = null;
let activeOobCode = null;
let optionalCode = { code: null, expiresAt: 0 };

function showToast(msg, type = "success") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  const styles = {
    success: "bg-emerald-950/95 border-emerald-500/60 text-emerald-100",
    error: "bg-red-950/95 border-red-500/60 text-red-100",
    info: "bg-brand-card/95 border-brand-yellow/60 text-white"
  };
  const icons = {
    success: "fa-circle-check text-emerald-400",
    error: "fa-circle-exclamation text-red-400",
    info: "fa-circle-info text-brand-yellow"
  };
  el.className = `toast-enter pointer-events-auto border rounded-2xl px-4 py-3 shadow-2xl flex items-start gap-2.5 text-xs font-medium ${styles[type] || styles.info}`;
  el.innerHTML = `<i class="fa-solid ${icons[type] || icons.info} mt-0.5 text-sm shrink-0"></i><span class="leading-relaxed">${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.25s ease";
    setTimeout(() => el.remove(), 260);
  }, 4500);
}

function mapResetError(err) {
  const code = err?.code || "";
  if (code.includes("invalid-email")) return "E-mail inválido. Verifique e tente novamente.";
  if (code.includes("user-not-found")) return "Nenhuma conta encontrada com este e-mail.";
  if (code.includes("expired-action-code")) return "Este link de troca de senha expirou. Solicite um novo link.";
  if (code.includes("invalid-action-code")) return "Link de troca de senha inválido ou já utilizado.";
  if (code.includes("weak-password")) return "A nova senha é muito fraca. Use pelo menos 6 caracteres (misture letras e números).";
  if (code.includes("wrong-password") || code.includes("invalid-credential")) return "A senha atual digitada está incorreta.";
  if (code.includes("requires-recent-login")) return "Por segurança, faça login novamente antes de alterar a senha.";
  if (code.includes("too-many-requests")) return "Muitas tentativas em sequência. Aguarde alguns minutos e tente novamente.";
  return err?.message || "Não foi possível concluir a operação. Tente novamente.";
}

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

window.updateStrengthMeter = function (inputId, meterId) {
  const val = document.getElementById(inputId)?.value || "";
  const box = document.getElementById(meterId);
  if (!box) return;
  if (!val) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  let score = 0;
  if (val.length >= 6) score++;
  if (val.length >= 8) score++;
  if (/[A-Z]/.test(val) && /[a-z]/.test(val)) score++;
  if (/\d/.test(val)) score++;
  if (/[^A-Za-z0-9]/.test(val)) score++;

  const bar = box.querySelector(".strength-bar");
  const label = box.querySelector(".strength-label");
  if (score <= 1) {
    bar.style.width = "25%";
    bar.className = "strength-bar h-full bg-red-500 transition-all duration-300";
    label.textContent = "Força da senha: Fraca (use 6+ caracteres com letras e números)";
    label.className = "strength-label text-[11px] font-semibold mt-1 block text-red-400";
  } else if (score <= 3) {
    bar.style.width = "60%";
    bar.className = "strength-bar h-full bg-brand-yellow transition-all duration-300";
    label.textContent = "Força da senha: Boa";
    label.className = "strength-label text-[11px] font-semibold mt-1 block text-brand-yellow";
  } else {
    bar.style.width = "100%";
    bar.className = "strength-bar h-full bg-emerald-500 transition-all duration-300";
    label.textContent = "Força da senha: Forte e segura";
    label.className = "strength-label text-[11px] font-semibold mt-1 block text-emerald-400";
  }
};

function hideAllViews() {
  ["view-oob-loading", "view-oob-error", "view-oob-reset", "view-oob-success", "view-standard"].forEach((id) => {
    document.getElementById(id)?.classList.add("hidden");
  });
}

window.showStandardView = function (tab = "email") {
  hideAllViews();
  document.getElementById("view-standard")?.classList.remove("hidden");
  window.switchPageTab(tab);
};

window.switchPageTab = function (tab) {
  const tabs = ["email", "phone", "logged"];
  tabs.forEach((t) => {
    const btn = document.getElementById(`tab-btn-${t}`);
    const pane = document.getElementById(`tab-pane-${t}`);
    const active = t === tab;
    if (btn) {
      btn.className = active
        ? "py-2.5 px-2 rounded-xl font-bold text-xs bg-brand-yellow text-brand-black flex items-center justify-center gap-1.5"
        : "py-2.5 px-2 rounded-xl font-bold text-xs text-neutral-400 hover:text-white flex items-center justify-center gap-1.5";
    }
    if (pane) pane.classList.toggle("hidden", !active);
  });
};

window.copyResetPageLink = async function () {
  const cleanUrl = `${window.location.origin}${window.location.pathname}`;
  try {
    await navigator.clipboard.writeText(cleanUrl);
    showToast("Link da página de troca de senha copiado!");
  } catch {
    showToast(`Copie o link: ${cleanUrl}`, "info");
  }
};

window.handlePageSendEmailLink = async function (e) {
  e.preventDefault();
  const email = document.getElementById("page-reset-email").value.trim().toLowerCase();
  if (!email) return;
  const btn = document.getElementById("btn-page-email-reset");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Enviando link...`;
  try {
    await sendPasswordResetEmail(auth, email, getPasswordResetActionSettings());
    document.getElementById("page-email-sent-target").textContent = email;
    document.getElementById("page-email-sent-box")?.classList.remove("hidden");
    showToast(`Link oficial de troca de senha enviado para ${email}!`);
  } catch (err) {
    showToast(mapResetError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-paper-plane mr-2"></i>Enviar Link de Troca de Senha`;
  }
};

function extractOobCode(rawInput) {
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

window.handlePageCodeReset = async function (e) {
  e.preventDefault();
  const raw = document.getElementById("page-oob-input")?.value || "";
  const code = extractOobCode(raw);
  const newPass = document.getElementById("page-code-new-pass")?.value || "";
  const confirmPass = document.getElementById("page-code-confirm-pass")?.value || "";

  if (!code) return showToast("Cole o link ou código recebido no seu e-mail.", "error");
  if (newPass.length < 6) return showToast("A nova senha precisa ter no mínimo 6 caracteres.", "error");
  if (newPass !== confirmPass) return showToast("As duas senhas precisam ser iguais.", "error");

  const btn = document.getElementById("btn-page-code-reset");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Validando e salvando...`;
  try {
    await verifyPasswordResetCode(auth, code);
    await confirmPasswordReset(auth, code, newPass);
    document.getElementById("form-page-code-reset")?.reset();
    hideAllViews();
    document.getElementById("view-oob-success")?.classList.remove("hidden");
    showToast("Nova senha salva com sucesso!");
  } catch (err) {
    showToast(mapResetError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-check-double mr-1.5"></i>Confirmar e Salvar Nova Senha Agora`;
  }
};

window.handlePagePhoneReset = function (e) {
  e.preventDefault();
  const email = document.getElementById("page-phone-email").value.trim().toLowerCase();
  const phone = document.getElementById("page-phone-number").value.trim();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  document.getElementById("page-phone-code").textContent = code;
  const msg = `Olá *Suporte JP RH*! Solicito troca de senha:\n\n*E-mail:* ${email}\n*Telefone:* ${phone}\n*Código de Verificação:* ${code}`;
  document.getElementById("page-phone-wa-link").href = `https://wa.me/${WHATSAPP_JPRH}?text=${encodeURIComponent(msg)}`;
  document.getElementById("page-phone-result")?.classList.remove("hidden");
  showToast(`Código ${code} gerado! Envie no WhatsApp para confirmar.`, "info");
};

window.handleSendOptionalCode = function () {
  if (!currentUser) return;
  const code = String(Math.floor(100000 + Math.random() * 900000));
  optionalCode = { code, expiresAt: Date.now() + 10 * 60 * 1000 };
  const msg = `Código de segurança JP RH (${currentUser.email}): *${code}* (válido por 10 min).`;
  window.open(`https://wa.me/${WHATSAPP_JPRH}?text=${encodeURIComponent(msg)}`, "_blank", "noopener,noreferrer");
  document.getElementById("logged-code-box")?.classList.remove("hidden");
  document.getElementById("logged-code-hint").textContent = `Código preparado para WhatsApp. Digite os 6 dígitos abaixo antes de salvar sua nova senha.`;
  showToast("Código de 6 dígitos preparado no WhatsApp!", "info");
};

window.handlePageLoggedChangePassword = async function (e) {
  e.preventDefault();
  if (!currentUser) return;
  const currentPass = document.getElementById("logged-current-pass").value;
  const newPass = document.getElementById("logged-new-pass").value;
  const confirmPass = document.getElementById("logged-confirm-pass").value;
  const codeInput = (document.getElementById("logged-code-input")?.value || "").trim();

  if (newPass.length < 6) return showToast("A nova senha precisa ter pelo menos 6 caracteres.", "error");
  if (newPass !== confirmPass) return showToast("A confirmação da nova senha não confere.", "error");
  if (optionalCode.code) {
    if (Date.now() > optionalCode.expiresAt) return showToast("Código expirado. Gere um novo código.", "error");
    if (codeInput !== optionalCode.code) return showToast("Código de 6 dígitos incorreto.", "error");
  }

  const btn = document.getElementById("btn-logged-change");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Atualizando...`;
  try {
    await reauthenticateWithCredential(currentUser, EmailAuthProvider.credential(currentUser.email, currentPass));
    await updatePassword(currentUser, newPass);
    document.getElementById("form-page-logged-change").reset();
    document.getElementById("logged-strength")?.classList.add("hidden");
    document.getElementById("logged-code-box")?.classList.add("hidden");
    optionalCode = { code: null, expiresAt: 0 };
    document.getElementById("status-done-banner")?.classList.remove("hidden");
    showToast("Senha atualizada com sucesso!");
  } catch (err) {
    showToast(mapResetError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-key mr-2"></i>Atualizar Minha Senha Agora`;
  }
};

window.handleConfirmOobReset = async function (e) {
  e.preventDefault();
  if (!activeOobCode) return;
  const newPass = document.getElementById("oob-new-pass").value;
  const confirmPass = document.getElementById("oob-confirm-pass").value;

  if (newPass.length < 6) return showToast("A nova senha precisa ter no mínimo 6 caracteres.", "error");
  if (newPass !== confirmPass) return showToast("As duas senhas precisam ser iguais.", "error");

  const btn = document.getElementById("btn-oob-confirm");
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Salvando nova senha...`;
  try {
    await confirmPasswordReset(auth, activeOobCode, newPass);
    hideAllViews();
    document.getElementById("view-oob-success")?.classList.remove("hidden");
    showToast("Nova senha salva com sucesso!");
  } catch (err) {
    showToast(mapResetError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-key mr-2"></i>Salvar Nova Senha`;
  }
};

async function initPage() {
  const cleanUrl = `${window.location.origin}${window.location.pathname}`;
  const urlEl = document.getElementById("direct-reset-url");
  if (urlEl) urlEl.textContent = cleanUrl;

  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode");
  const oobCode = params.get("oobCode");
  const prefillEmail = params.get("email");
  const status = params.get("status");
  const tabParam = params.get("tab");

  if (status === "senha-atualizada") {
    document.getElementById("status-done-banner")?.classList.remove("hidden");
  }

  if (prefillEmail) {
    const emailIn = document.getElementById("page-reset-email");
    const phoneEmailIn = document.getElementById("page-phone-email");
    if (emailIn) emailIn.value = prefillEmail;
    if (phoneEmailIn) phoneEmailIn.value = prefillEmail;
  }

  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    const outBox = document.getElementById("logged-out-notice");
    const inBox = document.getElementById("logged-in-box");
    const emailSpan = document.getElementById("logged-user-email");
    if (user) {
      outBox?.classList.add("hidden");
      inBox?.classList.remove("hidden");
      if (emailSpan) emailSpan.textContent = user.email || "";
      const emailIn = document.getElementById("page-reset-email");
      if (emailIn && !emailIn.value && user.email) emailIn.value = user.email;
    } else {
      outBox?.classList.remove("hidden");
      inBox?.classList.add("hidden");
    }
  });

  if (mode === "resetPassword" && oobCode) {
    activeOobCode = oobCode;
    hideAllViews();
    document.getElementById("view-oob-loading")?.classList.remove("hidden");
    try {
      const email = await verifyPasswordResetCode(auth, oobCode);
      document.getElementById("oob-account-email").textContent = email;
      hideAllViews();
      document.getElementById("view-oob-reset")?.classList.remove("hidden");
    } catch (err) {
      document.getElementById("oob-error-msg").textContent = mapResetError(err);
      hideAllViews();
      document.getElementById("view-oob-error")?.classList.remove("hidden");
    }
    return;
  }

  if (tabParam && ["email", "phone", "logged"].includes(tabParam)) {
    window.switchPageTab(tabParam);
  }
}

initPage();
