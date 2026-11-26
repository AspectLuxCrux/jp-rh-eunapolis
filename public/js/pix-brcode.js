// Gerador de Pix Copia e Cola (Padrão EMV / Banco Central do Brasil) com CRC16-CCITT

function normalizeAscii(str, maxLen) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 .,-]/g, "")
    .trim()
    .toUpperCase()
    .slice(0, maxLen);
}

function normalizePixKey(rawKey) {
  const key = String(rawKey || "").trim();
  if (!key) return "+5573981443993";
  // Email or random UUID key
  if (key.includes("@") || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(key)) {
    return key;
  }
  // Already starts with +55
  if (key.startsWith("+")) {
    return "+" + key.replace(/\D/g, "");
  }
  const digits = key.replace(/\D/g, "");
  // Brazilian phone with parentheses or 10-11 digits starting with DDD + 9
  if (key.includes("(") || (digits.length === 11 && digits[2] === "9")) {
    return `+55${digits}`;
  }
  // CPF (11 digits) or CNPJ (14 digits)
  if (digits.length === 11 || digits.length === 14) {
    return digits;
  }
  return key;
}

function emvField(id, value) {
  const str = String(value);
  const len = String(str.length).padStart(2, "0");
  return `${id}${len}${str}`;
}

function crc16Ccitt(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export function generatePixPayload({ chavePix, titular, cidade = "EUNAPOLIS", valor, txid = "JPRH" }) {
  const key = normalizePixKey(chavePix);
  const merchantName = normalizeAscii(titular || "JP RH EUNAPOLIS", 25) || "JP RH EUNAPOLIS";
  const merchantCity = normalizeAscii(cidade, 15) || "EUNAPOLIS";
  const cleanTxid = String(txid || "JPRH").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 25) || "JPRH";
  const amount = Number(valor || 0).toFixed(2);

  const gui = emvField("00", "br.gov.bcb.pix");
  const keyField = emvField("01", key);
  const merchantAccount = emvField("26", gui + keyField);

  let payload = "";
  payload += emvField("00", "01"); // Payload Format Indicator
  payload += merchantAccount;
  payload += emvField("52", "0000"); // Merchant Category Code
  payload += emvField("53", "986"); // BRL Currency
  if (Number(valor) > 0) {
    payload += emvField("54", amount);
  }
  payload += emvField("58", "BR");
  payload += emvField("59", merchantName);
  payload += emvField("60", merchantCity);
  payload += emvField("62", emvField("05", cleanTxid));
  payload += "6304"; // CRC16 tag + length

  return payload + crc16Ccitt(payload);
}

export function getPixQrImageUrl(pixPayload, size = 220) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=8&data=${encodeURIComponent(pixPayload)}`;
}
