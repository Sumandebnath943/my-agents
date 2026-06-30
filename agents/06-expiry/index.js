// agents/06-expiry/index.js
import tls from "node:tls";
import { DOMAINS, WARN_DAYS } from "./domains.js";
import { notifyTelegram } from "../../lib/notify.js";

function sslDaysLeft(host) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const cert = socket.getPeerCertificate();
      const days = cert.valid_to
        ? Math.round((new Date(cert.valid_to) - Date.now()) / 86400000)
        : null;
      socket.end();
      resolve(days);
    });
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => { socket.destroy(); resolve(null); });
  });
}

async function domainDaysLeft(domain) {
  // RDAP is the modern, free, JSON replacement for WHOIS.
  try {
    const r = await fetch(`https://rdap.org/domain/${domain}`);
    if (!r.ok) return null;
    const data = await r.json();
    const ev = (data.events || []).find((e) => e.eventAction === "expiration");
    return ev ? Math.round((new Date(ev.eventDate) - Date.now()) / 86400000) : null;
  } catch { return null; }
}

const alerts = [];
for (const d of DOMAINS) {
  const [ssl, reg] = await Promise.all([sslDaysLeft(d), domainDaysLeft(d)]);
  if (ssl != null && ssl <= WARN_DAYS) alerts.push(`🔒 *${d}* SSL expires in ${ssl} days`);
  if (reg != null && reg <= WARN_DAYS) alerts.push(`🌐 *${d}* domain expires in ${reg} days`);
}

if (alerts.length) await notifyTelegram(`⏰ *Expiry warning*\n\n${alerts.join("\n")}`);
else console.log("All domains/certs healthy.");
