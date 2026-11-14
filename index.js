import "dotenv/config";
import express from "express";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle
} from "discord.js";

const required = ["DISCORD_TOKEN", "ADMIN_IDS"];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`Falta ${name} en .env`);
    process.exit(1);
  }
}

const adminIds = new Set(
  process.env.ADMIN_IDS.split(",").map(v => v.trim()).filter(Boolean)
);
const dataDir = process.env.DATA_DIR || ".";
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, "keys.sqlite"));
db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL UNIQUE,
    key_hint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS free_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL UNIQUE,
    key_value TEXT NOT NULL,
    key_hint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    assigned_to TEXT UNIQUE,
    assigned_at INTEGER
  );
`);
const insertKey = db.prepare(
  "INSERT INTO keys (key_hash, key_hint, status, created_at, expires_at, created_by) VALUES (?, ?, 'active', ?, ?, ?)"
);
const findKey = db.prepare("SELECT * FROM keys WHERE key_hash = ?");
const updateStatus = db.prepare("UPDATE keys SET status = ? WHERE key_hash = ?");
const updateExpiry = db.prepare("UPDATE keys SET expires_at = ?, status = 'expired' WHERE key_hash = ?");
const listKeys = db.prepare("SELECT key_hint, status, expires_at FROM keys ORDER BY id DESC LIMIT 15");
const countStatus = db.prepare("SELECT COUNT(*) AS n FROM keys WHERE status = ?");
const countAll = db.prepare("SELECT COUNT(*) AS n FROM keys");
const freeKeyCount = db.prepare("SELECT COUNT(*) AS n FROM free_keys");
const findFreeKey = db.prepare("SELECT * FROM free_keys WHERE key_hash = ?");
const findUserFreeKey = db.prepare("SELECT * FROM free_keys WHERE assigned_to = ?");
const freeKeyStats = db.prepare("SELECT COUNT(*) AS n FROM free_keys WHERE assigned_to IS NULL AND status='active'");

// El bot carga exactamente las mismas 500 keys que están publicadas en Index.html.
// Si existía el inventario aleatorio de la versión anterior, conserva las cuentas asignadas
// y les reasigna una key del nuevo inventario compartido.
function seedFreeKeys() {
  const sharedKeys = JSON.parse(readFileSync(new URL("./free-keys.json", import.meta.url), "utf8"));
  if (!Array.isArray(sharedKeys) || sharedKeys.length !== 500 || new Set(sharedKeys.map(sha)).size !== 500) {
    throw new Error("free-keys.json debe contener exactamente 500 keys únicas.");
  }
  const existingRows = db.prepare("SELECT * FROM free_keys ORDER BY id").all();
  const sharedHashes = new Set(sharedKeys.map(sha));
  if (existingRows.length === 500 && existingRows.every(row => sharedHashes.has(row.key_hash))) return;
  const oldAssigned = existingRows.filter(row => row.assigned_to);
  if (oldAssigned.length > 500) throw new Error("Hay más de 500 cuentas asignadas; no se puede migrar el inventario.");
  const insert = db.prepare(`INSERT INTO free_keys
    (key_hash, key_value, key_hint, status, created_at, expires_at, assigned_to, assigned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const created = now();
  const duration = parseDuration(process.env.FREE_KEY_DURATION || "30d") || 2592000;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM free_keys");
    let assignedIndex = 0;
    for (const key of sharedKeys) {
      const old = oldAssigned[assignedIndex];
      const assigned = Boolean(old);
      insert.run(
        sha(key), key, key.slice(-4), assigned ? old.status : "active",
        assigned ? old.created_at : created,
        assigned ? old.expires_at : created + duration,
        assigned ? old.assigned_to : null,
        assigned ? old.assigned_at : null
      );
      if (assigned) assignedIndex++;
    }
    db.exec("COMMIT");
    console.log("Inventario compartido de 500 keys cargado desde free-keys.json.");
    if (oldAssigned.length) console.log("Se conservaron las asignaciones anteriores; las personas recibirán su nueva key compartida al usar /key.");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function issueFreeKey(userId) {
  const existing = findUserFreeKey.get(userId);
  if (existing) return { existing: true, record: existing };
  db.exec("BEGIN IMMEDIATE");
  try {
    const alreadyAssigned = findUserFreeKey.get(userId);
    if (alreadyAssigned) {
      db.exec("COMMIT");
      return { existing: true, record: alreadyAssigned };
    }
    const row = db.prepare("SELECT * FROM free_keys WHERE assigned_to IS NULL AND status='active' AND expires_at > ? ORDER BY id LIMIT 1").get(now());
    if (!row) { db.exec("COMMIT"); return null; }
    const result = db.prepare("UPDATE free_keys SET assigned_to=?, assigned_at=? WHERE id=? AND assigned_to IS NULL").run(userId, now(), row.id);
    db.exec("COMMIT");
    if (!result.changes) return issueFreeKey(userId);
    return { existing: false, record: { ...row, assigned_to: userId, assigned_at: now() } };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

const sha = value => createHash("sha256").update(value.trim().toUpperCase()).digest("hex");
const now = () => Math.floor(Date.now() / 1000);
const formatDate = seconds => new Date(seconds * 1000).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" });

function parseDuration(input) {
  const match = /^([1-9]\d{0,5})(mo|m|h|d|w)$/i.exec(input.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const seconds = {
    m: 60, h: 3600, d: 86400, w: 604800, mo: 2592000
  }[unit];
  const total = amount * seconds;
  if (!Number.isSafeInteger(total) || total > 315360000) return null;
  return total;
}

function makeKey() {
  const part = () => randomBytes(3).toString("hex").toUpperCase();
  return `RUZZOS-${part()}-${part()}`;
}

seedFreeKeys();

function getRecord(rawKey) {
  return findKey.get(sha(rawKey));
}

function effectiveStatus(record) {
  if (!record) return "not_found";
  if (record.status === "blocked") return "blocked";
  if (record.expires_at <= now()) return "expired";
  return "active";
}

function isAdmin(userId) {
  return adminIds.has(userId);
}

function stats() {
  const timestamp = now();
  db.prepare("UPDATE keys SET status = 'expired' WHERE status = 'active' AND expires_at <= ?").run(timestamp);
  return {
    all: countAll.get().n,
    active: countStatus.get("active").n,
    blocked: countStatus.get("blocked").n,
    expired: countStatus.get("expired").n
  };
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async readyClient => {
  console.log(`Bot conectado como ${readyClient.user.tag}`);
  try {
    const commands = await readyClient.application.commands.fetch();
    for (const name of ["key", "getkey"]) {
      const found = commands.find(command => command.name === name);
      if (!found) await readyClient.application.commands.create({
        name, description: "Recibe tu key gratuita personal (una por usuario)."
      });
    }
    console.log("Comandos /key y /getkey disponibles.");
  } catch (error) {
    console.error("No se pudo registrar /getkey automáticamente:", error.message);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isButton()) {
    if (!isAdmin(interaction.user.id)) {
      return interaction.reply({ content: "No tienes permiso para usar este panel.", ephemeral: true });
    }
    if (interaction.customId === "panel:stats" || interaction.customId === "panel:refresh") {
      const s = stats();
      const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle("♛ RÚZZOS NET — KEY MANAGER")
        .addFields(
          { name: "Total", value: String(s.all), inline: true },
          { name: "Activas", value: String(s.active), inline: true },
          { name: "Bloqueadas", value: String(s.blocked), inline: true },
          { name: "Vencidas", value: String(s.expired), inline: true }
        )
        .setFooter({ text: "RÚZZOS NET • Panel administrativo" });
      return interaction.update({ embeds: [embed] });
    }
    if (interaction.customId === "panel:active") {
      stats();
      const rows = db.prepare("SELECT key_hint, expires_at FROM keys WHERE status='active' AND expires_at > ? ORDER BY expires_at ASC LIMIT 10").all(now());
      const description = rows.length
        ? rows.map(r => `• \`${r.key_hint}\` — vence ${formatDate(r.expires_at)}`).join("\n")
        : "No hay KEY activas.";
      const embed = new EmbedBuilder().setColor(0x22c55e).setTitle("KEY activas").setDescription(description);
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  if (!interaction.isChatInputCommand()) return;
  if (["key", "getkey"].includes(interaction.commandName)) {
    await interaction.deferReply({ ephemeral: true });
    try {
      const issued = issueFreeKey(interaction.user.id);
      if (!issued) return interaction.editReply("Se agotaron las 500 keys gratuitas. Vuelve a intentarlo más adelante.");
      const { record, existing } = issued;
      const expiry = formatDate(record.expires_at);
      const text = existing
        ? `Ya tienes una key asignada. Tu key personal es: ||\`${record.key_value}\`||\nVence: **${expiry}**`
        : `¡Aquí tienes tu key gratuita personal! ||\`${record.key_value}\`||\nVence: **${expiry}**\nEsta key está vinculada a tu cuenta de Discord y no se puede volver a entregar a otra persona.`;
      try {
        await interaction.user.send(text);
        return interaction.editReply(existing ? "Te envié por privado la key que ya tenías asignada." : "¡Listo! Te envié tu key por mensaje privado.");
      } catch {
        return interaction.editReply(`No pude enviarte un DM. Activa los mensajes directos del servidor y vuelve a usar /key. Tu key ya quedó reservada: ||\`${record.key_value}\`||`);
      }
    } catch (error) {
      console.error(error);
      return interaction.editReply("No pude asignar tu key. Inténtalo de nuevo más tarde.");
    }
  }
  if (!isAdmin(interaction.user.id)) {
    return interaction.reply({ content: "No tienes permiso para administrar las KEY.", ephemeral: true });
  }

  const command = interaction.commandName;
  try {
    if (command === "crear-key") {
      const input = interaction.options.getString("duracion", true);
      const duration = parseDuration(input);
      if (!duration) {
        return interaction.reply({ content: "Duración no válida. Usa, por ejemplo: `45m`, `1h`, `1d`, `7d`, `30d`, `2w` o `1mo` (mes de 30 días).", ephemeral: true });
      }
      const key = makeKey();
      const created = now();
      insertKey.run(sha(key), key.slice(-4), created, created + duration, interaction.user.id);
      return interaction.reply({
        content: `**KEY creada correctamente**\n||\`${key}\`||\nDuración: \`${input}\`\nVencimiento: **${formatDate(created + duration)}**\nGuárdala ahora: no se almacena en texto legible y no se podrá volver a mostrar completa.`,
        ephemeral: true
      });
    }

    if (command === "ver-key") {
      const record = getRecord(interaction.options.getString("key", true));
      if (!record) return interaction.reply({ content: "No encontré esa KEY.", ephemeral: true });
      const status = effectiveStatus(record);
      if (status === "expired" && record.status === "active") updateStatus.run("expired", record.key_hash);
      return interaction.reply({
        content: `**KEY:** termina en \`${record.key_hint}\`\n**Estado:** ${status}\n**Vencimiento:** ${formatDate(record.expires_at)}\n**Creada por:** <@${record.created_by}>`,
        ephemeral: true
      });
    }

    if (["bloquear-key", "activar-key", "vencer-key"].includes(command)) {
      const raw = interaction.options.getString("key", true);
      const record = getRecord(raw);
      if (!record) return interaction.reply({ content: "No encontré esa KEY.", ephemeral: true });
      const hash = record.key_hash;
      if (command === "bloquear-key") {
        updateStatus.run("blocked", hash);
        return interaction.reply({ content: `KEY terminada en \`${record.key_hint}\` bloqueada.`, ephemeral: true });
      }
      if (command === "activar-key") {
        if (record.expires_at <= now()) {
          updateStatus.run("expired", hash);
          return interaction.reply({ content: "No se puede reactivar: esta KEY ya venció. Crea una nueva.", ephemeral: true });
        }
        updateStatus.run("active", hash);
        return interaction.reply({ content: `KEY terminada en \`${record.key_hint}\` reactivada.`, ephemeral: true });
      }
      updateExpiry.run(now(), hash);
      return interaction.reply({ content: `KEY terminada en \`${record.key_hint}\` vencida inmediatamente.`, ephemeral: true });
    }

    if (command === "keys") {
      stats();
      const filter = interaction.options.getString("estado") ?? "all";
      let rows;
      if (filter === "all") rows = listKeys.all();
      else if (filter === "expired") rows = db.prepare("SELECT key_hint,status,expires_at FROM keys WHERE status='expired' OR expires_at <= ? ORDER BY id DESC LIMIT 15").all(now());
      else rows = db.prepare("SELECT key_hint,status,expires_at FROM keys WHERE status=? ORDER BY id DESC LIMIT 15").all(filter);
      const description = rows.length
        ? rows.map(r => `• \`****${r.key_hint}\` — **${effectiveStatus({ ...r, expires_at: r.expires_at })}** — ${formatDate(r.expires_at)}`).join("\n")
        : "No hay resultados.";
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x8b5cf6).setTitle("Registro de KEY (máximo 15)").setDescription(description)], ephemeral: true });
    }

    if (command === "estadisticas" || command === "panel") {
      const s = stats();
      const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle("♛ RÚZZOS NET — KEY MANAGER")
        .setDescription("Panel administrativo de licencias")
        .addFields(
          { name: "Total", value: String(s.all), inline: true },
          { name: "Activas", value: String(s.active), inline: true },
          { name: "Bloqueadas", value: String(s.blocked), inline: true },
          { name: "Vencidas", value: String(s.expired), inline: true }
        )
        .setFooter({ text: "Usa /crear-key, /ver-key, /bloquear-key y otros comandos." });
      if (command === "estadisticas") return interaction.reply({ embeds: [embed], ephemeral: true });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("panel:stats").setLabel("Actualizar estadísticas").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("panel:active").setLabel("Ver KEY activas").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("panel:refresh").setLabel("Actualizar panel").setStyle(ButtonStyle.Primary)
      );
      return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }
  } catch (error) {
    console.error(error);
    const message = { content: "Ocurrió un error interno. Revisa la terminal del bot.", ephemeral: true };
    if (interaction.replied || interaction.deferred) return interaction.followUp(message);
    return interaction.reply(message);
  }
});

// API para que la página web valide las KEY contra la misma base de datos.
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

const allowedOrigin = process.env.WEB_ORIGIN || "*";
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const attempts = new Map();
app.use("/api/validate", (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const current = Date.now();
  const entry = attempts.get(ip) || { count: 0, start: current };
  if (current - entry.start > 60_000) {
    entry.count = 0;
    entry.start = current;
  }
  entry.count += 1;
  attempts.set(ip, entry);
  if (entry.count > 30) return res.status(429).json({ valid: false, message: "Demasiados intentos. Espera un minuto." });
  next();
});

app.get("/health", (_req, res) => res.json({ online: true, service: "RÚZZOS NET KEY API" }));

app.post("/api/validate", (req, res) => {
  const key = typeof req.body?.key === "string" ? req.body.key.trim().toUpperCase() : "";
  if (!key || key.length > 100) return res.status(400).json({ valid: false, message: "Escribe una KEY." });
  const freeRecord = findFreeKey.get(sha(key));
  if (!freeRecord) return res.json({ valid: false, status: "invalid", message: "KEY incorrecta. Solo se aceptan las 500 keys del inventario del bot." });
  if (!freeRecord.assigned_to) {
    return res.json({ valid: false, status: "not_issued", message: "Esta key todavía no ha sido entregada por el bot." });
  }
  const status = effectiveStatus(freeRecord);
  if (status === "expired" && freeRecord.status === "active") {
    db.prepare("UPDATE free_keys SET status='expired' WHERE key_hash=?").run(freeRecord.key_hash);
  }
  if (status !== "active") {
    const message = status === "blocked" ? "Esta KEY está bloqueada." : "Esta KEY ha vencido.";
    return res.json({ valid: false, status, message });
  }
  return res.json({ valid: true, status: "active", expiresAt: freeRecord.expires_at, message: "KEY válida." });
});

const port = Number(process.env.PORT || process.env.API_PORT || 3000);
app.listen(port, "0.0.0.0", () => console.log(`API de validación escuchando en el puerto ${port}`));

client.login(process.env.DISCORD_TOKEN);
