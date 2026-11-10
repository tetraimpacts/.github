// Check del comprobante de seguridad (plan 0001 de la plataforma, pieza 6).
//
// GitHub no escanea: verifica. `tetra seguridad` escanea en la máquina de la persona el
// último commit de la rama y `tetra pr` deja su comprobante en la última línea
// «Seguridad:» de la descripción del PR, dentro de un comentario HTML. Este check comprueba
// que el comprobante es de este repo y del head actual, con herramientas y reglas
// aceptadas, que su resultado cumple la política y, si viene firmado, que la firma es de
// una llave de firma que GitHub publica del autor del PR o del último commit.
//
// Sin firma pasa con aviso: firmar todavía no es obligatorio. Con la variable de
// organización TETRA_SEGURIDAD_MODO en «bloquea», los problemas hacen fallar el check; en
// cualquier otro valor solo avisan. Lee el PR por la API, nunca del evento, y no escribe
// nada en ningún repo. En los registros solo van conteos, nunca el detalle de un hallazgo.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Espacio de nombres de la firma: el mismo con el que firma tetra. */
export const ESPACIO = "tetra-seguridad";

const OCULTO = /<!--\s*(\S+)\s+([A-Za-z0-9+/]+={0,2})\s+(\S+)\s*-->/;

/** La última línea «Seguridad: ...» de la descripción y el comprobante que lleva. */
export function lineaSeguridad(cuerpo) {
  let ultima = null;
  for (const linea of (cuerpo ?? "").split(/\r?\n/)) {
    const m = /^\s*Seguridad:\s*(.*?)\s*$/.exec(linea);
    if (m) ultima = m[1];
  }
  if (ultima === null) return { tipo: "falta" };
  const m = OCULTO.exec(ultima);
  if (!m) return { tipo: "invalida" };
  const canonico = Buffer.from(m[2], "base64").toString("utf8");
  return { tipo: "comprobante", formato: m[1], canonico, firma: m[3] === "-" ? null : m[3] };
}

/** La firma de tetra (base64 sin cabeceras) como la escribe `ssh-keygen -Y sign`. */
export function armadura(firma) {
  const lineas = firma.match(/.{1,70}/g) ?? [];
  return `-----BEGIN SSH SIGNATURE-----\n${lineas.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}

/**
 * ¿`firma` es de `texto` con alguna de `llaves` («tipo base64») de `principal`? Corre
 * `ssh-keygen -Y verify` con un `allowed_signers` armado con esas llaves.
 */
export function firmaValida({ texto, firma, principal, llaves, sshKeygen = "ssh-keygen" }) {
  if (!llaves.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(firma)) return false;
  const dir = mkdtempSync(join(tmpdir(), "tetra-seguridad-"));
  try {
    const permitidas = join(dir, "allowed_signers");
    const sig = join(dir, "comprobante.sig");
    writeFileSync(permitidas, llaves.map((k) => `${principal} namespaces="${ESPACIO}" ${k}\n`).join(""));
    writeFileSync(sig, armadura(firma));
    const r = spawnSync(sshKeygen, ["-Y", "verify", "-f", permitidas, "-I", principal, "-n", ESPACIO, "-s", sig], {
      input: texto,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 30_000,
    });
    return r.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function corto(sha) {
  return String(sha ?? "?").slice(0, 7);
}

function esBot(usuario) {
  return usuario?.type === "Bot" || (usuario?.login ?? "").endsWith("[bot]");
}

const REGLAS = [
  ["gitleaks.toml", ".gitleaks.toml"],
  ["gitleaksignore", ".gitleaksignore"],
];

/**
 * Revisa el comprobante del PR. `api` da:
 * - `repo(nombre)`: `{ id }` o null.
 * - `pr(nombre, numero)`: `{ body, head: { sha }, user }` o null.
 * - `autorDelCommit(nombre, sha)`: login del autor en GitHub o null.
 * - `archivo(nombre, ruta, sha)`: los bytes del archivo en ese commit o null.
 * - `llavesDeFirma(login)`: lista de llaves «tipo base64».
 * Da `{ problemas, avisos, resumen }`: los problemas fallan el check en modo «bloquea».
 */
export async function verificar({ api, org, repo, numero, politica, firmaValida: comprobar = firmaValida }) {
  const problemas = [];
  const avisos = [];
  const aqui = await api.repo(repo);
  if (!aqui) return { problemas: [`No encuentro el repo ${org}/${repo}.`], avisos, resumen: null };
  const pr = await api.pr(repo, numero);
  if (!pr) return { problemas: [`No encuentro el PR #${numero} de ${org}/${repo}.`], avisos, resumen: null };
  if (esBot(pr.user)) return { problemas, avisos: ["Lo abrió un bot: no lleva comprobante."], resumen: null };

  const pedir = "corre tetra seguridad en el último commit de la rama y luego tetra pr";
  const linea = lineaSeguridad(pr.body);
  if (linea.tipo === "falta") {
    return { problemas: [`Falta la línea «Seguridad:» en la descripción: ${pedir}.`], avisos, resumen: null };
  }
  if (linea.tipo === "invalida") {
    return {
      problemas: [`La línea «Seguridad:» no lleva el comprobante que escribe tetra pr: ${pedir}.`],
      avisos,
      resumen: null,
    };
  }
  if (!politica.formatos.includes(linea.formato)) {
    return { problemas: [`No conozco el formato ${linea.formato}.`], avisos, resumen: null };
  }
  let c;
  try {
    c = JSON.parse(linea.canonico);
  } catch {
    return { problemas: ["El comprobante no es JSON."], avisos, resumen: null };
  }
  if (c?.formato !== linea.formato) problemas.push("El formato del comprobante no coincide con el de la línea.");

  if (c.repo_id !== aqui.id) problemas.push(`El comprobante es de otro repo (${c.repo ?? "sin nombre"}).`);
  const head = pr.head?.sha;
  if (c.head !== head) {
    problemas.push(`El comprobante es del commit ${corto(c.head)} y el PR va en ${corto(head)}: ${pedir}.`);
  }

  for (const [herramienta, aceptadas] of Object.entries(politica.herramientas ?? {})) {
    const v = c.herramientas?.[herramienta];
    if (!v) problemas.push(`El comprobante no dice que corriera ${herramienta}.`);
    else if (aceptadas.length && !aceptadas.includes(v)) {
      problemas.push(`${herramienta} ${v} no es una versión aceptada (${aceptadas.join(", ")}).`);
    }
  }

  if (c.head === head) {
    for (const [clave, ruta] of REGLAS) {
      const bytes = await api.archivo(repo, ruta, head);
      const esperado = bytes === null ? "por-defecto" : sha256(bytes);
      if (c.reglas?.[clave] !== esperado) problemas.push(`Las reglas de ${ruta} del comprobante no son las del commit.`);
    }
  }

  const secretos = Number(c.conteos?.gitleaks?.secretos ?? NaN);
  const osv = c.conteos?.["osv-scanner"] ?? {};
  const bloquean = politica.bloquean ?? ["critica", "alta"];
  const graves = bloquean.reduce((n, s) => n + Number(osv[s] ?? NaN), 0);
  if (!Number.isInteger(secretos) || !Number.isInteger(graves)) {
    problemas.push("El comprobante no trae los conteos de gitleaks y osv-scanner.");
  } else {
    const cumple = secretos === 0 && graves === 0;
    if (c.cumple !== cumple) problemas.push("El campo cumple del comprobante no corresponde a sus conteos.");
    if (!cumple) {
      problemas.push(
        `No cumple la política: ${secretos} posibles secretos y ${graves} avisos ${bloquean.join(" o ")} en dependencias.`,
      );
    }
  }

  let firma = "sin firmar";
  if (!linea.firma) {
    avisos.push("Comprobante sin firmar: firma con tu llave SSH (tetra setup dice cómo) para que no salga este aviso.");
  } else {
    const firmante = String(c.autor ?? "");
    const autorPr = pr.user?.login ?? "";
    const autorCommit = (await api.autorDelCommit(repo, head)) ?? "";
    const puede = [autorPr, autorCommit].filter(Boolean).map((l) => l.toLowerCase());
    if (!firmante || !puede.includes(firmante.toLowerCase())) {
      problemas.push(`Lo firmó ${firmante || "alguien sin login"}, que no es el autor del PR ni del último commit.`);
    } else {
      const llaves = await api.llavesDeFirma(firmante);
      if (!llaves.length) {
        problemas.push(`${firmante} no tiene llaves de firma SSH en GitHub: regístrala con gh ssh-key add --type signing.`);
      } else if (!comprobar({ texto: linea.canonico, firma: linea.firma, principal: firmante, llaves })) {
        problemas.push(`La firma no es de ninguna llave de firma de ${firmante}, o el comprobante cambió después de firmarlo.`);
      } else {
        firma = `firmado por ${firmante}`;
      }
    }
  }

  const resumen =
    `Comprobante de ${corto(c.head)}, ${firma}: ` +
    `gitleaks ${c.herramientas?.gitleaks ?? "?"} con ${Number.isInteger(secretos) ? secretos : "?"} posibles secretos; ` +
    `osv-scanner ${c.herramientas?.["osv-scanner"] ?? "?"} con ${osv.critica ?? "?"} críticos y ${osv.alta ?? "?"} altos.`;
  return { problemas, avisos, resumen };
}

/** La API de GitHub con el token de la App. */
export function apiDeGitHub({ token, org, base = "https://api.github.com", fetch: f = fetch }) {
  async function pedir(ruta, crudo = false) {
    const r = await f(`${base}${ruta}`, {
      headers: {
        Accept: crudo ? "application/vnd.github.raw" : "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "tetra-seguridad",
      },
      redirect: "follow",
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub respondió ${r.status} a ${ruta}`);
    return crudo ? Buffer.from(await r.arrayBuffer()) : r.json();
  }
  const repoDe = (nombre) => `/repos/${org}/${encodeURIComponent(nombre)}`;
  return {
    async repo(nombre) {
      const d = await pedir(repoDe(nombre));
      return d && { id: d.id };
    },
    async pr(nombre, numero) {
      const d = await pedir(`${repoDe(nombre)}/pulls/${numero}`);
      return d && { body: d.body, head: { sha: d.head?.sha }, user: { login: d.user?.login, type: d.user?.type } };
    },
    async autorDelCommit(nombre, sha) {
      const d = await pedir(`${repoDe(nombre)}/commits/${sha}`);
      return d?.author?.login ?? null;
    },
    async archivo(nombre, ruta, sha) {
      return pedir(`${repoDe(nombre)}/contents/${encodeURIComponent(ruta)}?ref=${sha}`, true);
    },
    async llavesDeFirma(login) {
      const d = await pedir(`/users/${encodeURIComponent(login)}/ssh_signing_keys`);
      return (d ?? []).map((k) => String(k.key ?? "").split(/\s+/).slice(0, 2).join(" ")).filter(Boolean);
    },
  };
}

function resumen(texto) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${texto}\n`);
}

async function main() {
  const [org, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  const numero = Number(process.env.PR_NUMERO);
  const token = process.env.GH_TOKEN;
  if (!org || !repo || !Number.isInteger(numero) || numero < 1 || !token || !process.env.TETRA_POLITICA) {
    console.log("::error::Faltan GITHUB_REPOSITORY, PR_NUMERO, GH_TOKEN o TETRA_POLITICA.");
    process.exit(1);
  }
  const politica = JSON.parse(readFileSync(process.env.TETRA_POLITICA, "utf8"));
  const bloquea = (process.env.TETRA_SEGURIDAD_MODO ?? "").trim().toLowerCase() === "bloquea";
  const api = apiDeGitHub({ token, org, base: process.env.GITHUB_API_URL || undefined });
  const r = await verificar({ api, org, repo, numero, politica });

  const modo = bloquea ? "bloquea" : "solo avisa";
  resumen(`### tetra-seguridad (${modo})\n`);
  if (r.resumen) {
    console.log(r.resumen);
    resumen(`${r.resumen}\n`);
  }
  const nivel = bloquea ? "error" : "warning";
  for (const p of r.problemas) {
    console.log(`::${nivel}::${p}`);
    resumen(`- ${p}`);
  }
  for (const a of r.avisos) {
    console.log(`::warning::${a}`);
    resumen(`- ${a}`);
  }
  if (!r.problemas.length && !r.avisos.length) resumen("Sin problemas.");
  if (r.problemas.length && bloquea) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.log(`::error::${e.message}`);
    process.exit(1);
  });
}
