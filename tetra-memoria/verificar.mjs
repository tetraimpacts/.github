// Check del PR pareado (contrato tetra-memoria/2, sección 2.21).
//
// Un PR de código necesita su PR de memoria: la descripción termina con
// «Memoria: tetraimpacts/<memoria>#N», esa memoria es la del nodo que declara el repo y
// ese PR existe, abierto o fusionado. Compara repos por id y no por nombre, porque los
// nombres cambian con los renombres. «Memoria: no-aplica» solo vale para bots, PR de
// release y las personas autorizadas.
//
// Lee el PR por la API cada vez, nunca del evento: así un «Re-run» ve la descripción
// que tiene el PR ahora. No escribe nada en ningún repo.

import { readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const NOMBRE = /^[A-Za-z0-9._-]+$/;
const ENLACE =
  /^(?:tetraimpacts\/([A-Za-z0-9._-]+)#(\d+)|https:\/\/github\.com\/tetraimpacts\/([A-Za-z0-9._-]+)\/pull\/(\d+)\/?)$/;
const EXCEPCIONES = new Set(["no-aplica", "sin cambios"]);

/** La última línea «Memoria: ...» de la descripción. */
export function lineaMemoria(cuerpo) {
  let ultima = null;
  for (const linea of (cuerpo ?? "").split(/\r?\n/)) {
    const m = /^\s*Memoria:\s*(.*?)\s*$/.exec(linea);
    if (m) ultima = m[1];
  }
  if (ultima === null) return { tipo: "falta" };
  const valor = ultima.replace(/^[`*_]+|[`*_]+$/g, "");
  if (EXCEPCIONES.has(valor.toLowerCase())) return { tipo: "excepcion", valor: valor.toLowerCase() };
  const m = ENLACE.exec(valor);
  if (!m) return { tipo: "invalida" };
  return { tipo: "enlace", repo: m[1] ?? m[3], numero: Number(m[2] ?? m[4]) };
}

/** `tetraimpacts/x` o `x` a `x`; los de otra organización, a null. */
function corto(nombre, org) {
  if (typeof nombre !== "string" || nombre === "") return null;
  const partes = nombre.split("/");
  if (partes.length === 1) return NOMBRE.test(partes[0]) ? partes[0] : null;
  if (partes.length === 2 && partes[0].toLowerCase() === org.toLowerCase() && NOMBRE.test(partes[1]))
    return partes[1];
  return null;
}

/** Cada repo propio declarado (código y QA de tipo repo), con su nodo. */
export function declarados(manifiesto, org) {
  const salida = [];
  for (const nodo of manifiesto?.nodos ?? []) {
    const entradas = [
      ...(nodo.repos ?? []),
      ...(nodo.qa ?? []).filter((q) => (q.tipo ?? "repo") === "repo"),
    ];
    for (const r of entradas) {
      if (r.tercero === true || r.remoto === "tercero") continue;
      const nombre = corto(r.nombre, org);
      if (nombre) salida.push({ nodo, repo: r, nombre });
    }
  }
  return salida;
}

function esBot(usuario) {
  return usuario?.type === "Bot" || (usuario?.login ?? "").endsWith("[bot]");
}

function escapar(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function memoriaDe(nodo, org) {
  return corto(nodo?.memoria?.repo, org);
}

/**
 * Decide si el PR pasa. `api` da:
 * - `repo(nombre)`: `{ id, default_branch }` o null si no existe (sigue renombres).
 * - `pr(nombre, numero)`: `{ state, merged, body, base, head, user }` o null.
 */
export async function verificar({ api, org, repo, numero, autorizados }) {
  const manifiesto = api.manifiesto;
  const aqui = await api.repo(repo);
  if (!aqui) return { ok: false, motivo: `No encuentro el repo ${org}/${repo}.` };
  const pr = await api.pr(repo, numero);
  if (!pr) return { ok: false, motivo: `No encuentro el PR #${numero} de ${org}/${repo}.` };
  if (esBot(pr.user)) return { ok: true, aviso: "Lo abrió un bot: el PR pareado no aplica." };

  const lista = declarados(manifiesto, org);
  let mio = lista.find((d) => d.nombre.toLowerCase() === repo.toLowerCase());
  if (!mio) {
    // El nombre pudo cambiar antes que la cabecera: se compara por id.
    for (const d of lista) {
      const otro = await api.repo(d.nombre);
      if (otro && otro.id === aqui.id) {
        mio = d;
        break;
      }
    }
  }
  if (!mio) {
    return {
      ok: true,
      aviso: `${org}/${repo} no está declarado en ninguna cabecera de la noosfera: el PR pareado no aplica.`,
    };
  }

  const nodo = mio.nodo;
  const memoria = memoriaDe(nodo, org);
  if (!memoria) return { ok: false, motivo: `El nodo ${nodo.id} no declara su memoria en el manifiesto.` };
  const linea = lineaMemoria(pr.body);
  const ejemplo = `Memoria: ${org}/${memoria}#N`;

  if (linea.tipo === "falta") {
    return {
      ok: false,
      motivo:
        `Falta la línea «${ejemplo}» en la descripción. Abre el par con tetra pr, ` +
        `o abre el PR de memoria en ${org}/${memoria}, agrega la línea y vuelve a correr este check.`,
    };
  }
  if (linea.tipo === "invalida") {
    return {
      ok: false,
      motivo: `La línea Memoria: no tiene la forma «${ejemplo}» ni «Memoria: no-aplica».`,
    };
  }
  if (linea.tipo === "excepcion") {
    const autor = pr.user?.login ?? "";
    const trabajo = mio.repo.rama_trabajo;
    const principal = aqui.default_branch;
    const esRelease = Boolean(trabajo) && pr.head?.ref === trabajo && pr.base?.ref === principal;
    const autorizado = autorizados.some((a) => a.toLowerCase() === autor.toLowerCase());
    if (esRelease || autorizado) {
      const porque = esRelease ? `es un PR de release (${trabajo} a ${principal})` : `${autor} está autorizado`;
      return { ok: true, aviso: `«Memoria: ${linea.valor}» aceptada: ${porque}.` };
    }
    return {
      ok: false,
      motivo:
        `«Memoria: ${linea.valor}» solo vale para bots, PR de release y las personas autorizadas. ` +
        `Este cambio necesita su PR en ${org}/${memoria}: ábrelo con tetra pr.`,
    };
  }

  const suya = await api.repo(memoria);
  const enlazada = await api.repo(linea.repo);
  if (!suya) return { ok: false, motivo: `No encuentro la memoria ${org}/${memoria} del nodo ${nodo.id}.` };
  if (!enlazada || enlazada.id !== suya.id) {
    return {
      ok: false,
      motivo: `El PR de memoria tiene que ser de ${org}/${memoria}, la memoria de ${nodo.id}, y no de ${org}/${linea.repo}.`,
    };
  }
  const par = await api.pr(linea.repo, linea.numero);
  if (!par) return { ok: false, motivo: `No existe el PR ${org}/${linea.repo}#${linea.numero}.` };
  if (par.state !== "open" && !par.merged) {
    return { ok: false, motivo: `El PR ${org}/${linea.repo}#${linea.numero} está cerrado sin fusionar.` };
  }
  const vuelta = new RegExp(`^\\s*Código:\\s*${escapar(`${org}/${repo}`)}#${numero}\\s*$`, "im");
  const aviso = vuelta.test(par.body ?? "")
    ? undefined
    : `El PR de memoria todavía no lleva «Código: ${org}/${repo}#${numero}»; tetra pr lo agrega.`;
  return { ok: true, memoria: `${org}/${linea.repo}#${linea.numero}`, aviso };
}

/** La API de GitHub con el token de la App. */
export function apiDeGitHub({ token, org, manifiesto, base = "https://api.github.com", fetch: f = fetch }) {
  const repos = new Map();
  async function get(ruta) {
    const r = await f(`${base}${ruta}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "tetra-memoria",
      },
      redirect: "follow",
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub respondió ${r.status} a ${ruta}`);
    return r.json();
  }
  return {
    manifiesto,
    async repo(nombre) {
      const clave = nombre.toLowerCase();
      if (!repos.has(clave)) {
        const d = await get(`/repos/${org}/${encodeURIComponent(nombre)}`);
        repos.set(clave, d && { id: d.id, default_branch: d.default_branch });
      }
      return repos.get(clave);
    },
    async pr(nombre, numero) {
      const d = await get(`/repos/${org}/${encodeURIComponent(nombre)}/pulls/${numero}`);
      return (
        d && {
          state: d.state,
          merged: Boolean(d.merged),
          body: d.body,
          base: { ref: d.base?.ref },
          head: { ref: d.head?.ref },
          user: { login: d.user?.login, type: d.user?.type },
        }
      );
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
  if (!org || !repo || !Number.isInteger(numero) || numero < 1 || !token || !process.env.TETRA_MANIFIESTO) {
    console.log("::error::Faltan GITHUB_REPOSITORY, PR_NUMERO, GH_TOKEN o TETRA_MANIFIESTO.");
    process.exit(1);
  }
  const manifiesto = JSON.parse(readFileSync(process.env.TETRA_MANIFIESTO, "utf8"));
  const autorizados = (process.env.TETRA_AUTORIZADOS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const api = apiDeGitHub({ token, org, manifiesto, base: process.env.GITHUB_API_URL || undefined });
  const r = await verificar({ api, org, repo, numero, autorizados });
  if (r.ok) {
    const linea = r.memoria ? `PR pareado con ${r.memoria}.` : "PR pareado: no aplica o excepción aceptada.";
    console.log(linea);
    resumen(`### tetra-memoria\n\n${linea}`);
    if (r.aviso) {
      console.log(`::notice::${r.aviso}`);
      resumen(`\n${r.aviso}`);
    }
    return;
  }
  console.log(`::error::${r.motivo}`);
  resumen(`### tetra-memoria\n\n${r.motivo}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.log(`::error::${e.message}`);
    process.exit(1);
  });
}
