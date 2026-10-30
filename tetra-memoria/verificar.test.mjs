// node --test tetra-memoria/

import { test } from "node:test";
import assert from "node:assert/strict";

import { apiDeGitHub, declarados, lineaMemoria, verificar } from "./verificar.mjs";

const ORG = "tetraimpacts";

const MANIFIESTO = {
  nodos: [
    {
      id: "sitio-web",
      memoria: { repo: "tetraimpacts/sitio-web-project-memory" },
      repos: [
        { nombre: "tetraimpacts/tetra-v2", remoto: "existe", rama_trabajo: "dev" },
        { nombre: "tetraimpacts/tetra-kit-v2", remoto: "existe" },
      ],
      qa: [{ tipo: "repo", nombre: "tetraimpacts/tetraimpacts-qa" }],
    },
    {
      id: "la-bitacora",
      memoria: { repo: "tetraimpacts/sitio-web-project-memory", anfitrion: "sitio-web" },
      repos: [{ nombre: "tetraimpacts/la-bitacora-del-neuromancer" }],
      qa: [{ tipo: "perfil", nombre: "tetraimpacts/tetraimpacts-qa", perfil: "la-bitacora" }],
    },
    {
      id: "naat",
      memoria: { repo: "tetraimpacts/naat-project-memory" },
      repos: [{ nombre: "tetraimpacts/viejo-ocr" }],
    },
    {
      id: "laboratorio",
      memoria: { repo: "tetraimpacts/ingenieria-project-memory" },
      repos: [{ nombre: "pala", remoto: "tercero", tercero: true }],
    },
  ],
};

// Repos por nombre actual; los renombrados responden por su nombre viejo con el mismo id.
function mundo({ prs = {}, renombres = {} } = {}) {
  const ids = {
    "tetra-v2": { id: 1, default_branch: "main" },
    "tetra-kit-v2": { id: 2, default_branch: "main" },
    "tetraimpacts-qa": { id: 3, default_branch: "main" },
    "la-bitacora-del-neuromancer": { id: 4, default_branch: "main" },
    "sitio-web-project-memory": { id: 10, default_branch: "main" },
    "naat-project-memory": { id: 11, default_branch: "master" },
    "naat-ocr": { id: 5, default_branch: "master" },
    "suelto": { id: 99, default_branch: "main" },
  };
  for (const [viejo, nuevo] of Object.entries(renombres)) ids[viejo] = ids[nuevo];
  const llamadas = [];
  return {
    llamadas,
    manifiesto: MANIFIESTO,
    async repo(nombre) {
      llamadas.push(`repo ${nombre}`);
      return ids[nombre] ?? null;
    },
    async pr(nombre, numero) {
      llamadas.push(`pr ${nombre}#${numero}`);
      return prs[`${nombre}#${numero}`] ?? null;
    },
  };
}

function prDeCodigo(cuerpo, extra = {}) {
  return {
    state: "open",
    merged: false,
    body: cuerpo,
    base: { ref: "dev" },
    head: { ref: "f5/algo" },
    user: { login: "alguien", type: "User" },
    ...extra,
  };
}

const MEMORIA_ABIERTA = { state: "open", merged: false, body: "Código: tetraimpacts/tetra-v2#7" };

test("lee la última línea Memoria:", () => {
  assert.deepEqual(lineaMemoria("x\nMemoria: tetraimpacts/a#1\nMemoria: tetraimpacts/b#2"), {
    tipo: "enlace",
    repo: "b",
    numero: 2,
  });
  assert.deepEqual(lineaMemoria("Memoria: https://github.com/tetraimpacts/b/pull/9"), {
    tipo: "enlace",
    repo: "b",
    numero: 9,
  });
  assert.deepEqual(lineaMemoria("Memoria: `tetraimpacts/b#3`"), { tipo: "enlace", repo: "b", numero: 3 });
  assert.deepEqual(lineaMemoria("Memoria: No-aplica"), { tipo: "excepcion", valor: "no-aplica" });
  assert.deepEqual(lineaMemoria("Memoria: sin cambios"), { tipo: "excepcion", valor: "sin cambios" });
  assert.deepEqual(lineaMemoria("Memoria: tetraimpacts/<memoria>#N"), { tipo: "invalida" });
  assert.deepEqual(lineaMemoria("Memoria: otraorg/b#3"), { tipo: "invalida" });
  assert.deepEqual(lineaMemoria(null), { tipo: "falta" });
  assert.deepEqual(lineaMemoria("Sin línea"), { tipo: "falta" });
});

test("declarados deja fuera terceros y perfiles", () => {
  const nombres = declarados(MANIFIESTO, ORG).map((d) => `${d.nodo.id}:${d.nombre}`);
  assert.deepEqual(nombres, [
    "sitio-web:tetra-v2",
    "sitio-web:tetra-kit-v2",
    "sitio-web:tetraimpacts-qa",
    "la-bitacora:la-bitacora-del-neuromancer",
    "naat:viejo-ocr",
  ]);
});

test("pasa con su PR de memoria abierto o fusionado", async () => {
  for (const memoria of [MEMORIA_ABIERTA, { state: "closed", merged: true, body: "" }]) {
    const api = mundo({
      prs: {
        "tetra-v2#7": prDeCodigo("Cambio\n\nMemoria: tetraimpacts/sitio-web-project-memory#4"),
        "sitio-web-project-memory#4": memoria,
      },
    });
    const r = await verificar({ api, org: ORG, repo: "tetra-v2", numero: 7, autorizados: [] });
    assert.equal(r.ok, true);
    assert.equal(r.memoria, "tetraimpacts/sitio-web-project-memory#4");
  }
});

test("avisa si falta el enlace de vuelta", async () => {
  const api = mundo({
    prs: {
      "tetra-v2#7": prDeCodigo("Memoria: tetraimpacts/sitio-web-project-memory#4"),
      "sitio-web-project-memory#4": { state: "open", merged: false, body: "nada" },
    },
  });
  const r = await verificar({ api, org: ORG, repo: "tetra-v2", numero: 7, autorizados: [] });
  assert.equal(r.ok, true);
  assert.match(r.aviso, /Código: tetraimpacts\/tetra-v2#7/);
});

test("una ranura usa la memoria de su anfitrión", async () => {
  const api = mundo({
    prs: {
      "la-bitacora-del-neuromancer#2": prDeCodigo("Memoria: tetraimpacts/sitio-web-project-memory#5"),
      "sitio-web-project-memory#5": MEMORIA_ABIERTA,
    },
  });
  const r = await verificar({ api, org: ORG, repo: "la-bitacora-del-neuromancer", numero: 2, autorizados: [] });
  assert.equal(r.ok, true);
});

test("falla sin línea, con una línea mal formada o con otra memoria", async () => {
  const casos = [
    ["Sin enlace", /Falta la línea «Memoria: tetraimpacts\/sitio-web-project-memory#N»/],
    ["Memoria: pendiente", /no tiene la forma/],
    ["Memoria: tetraimpacts/naat-project-memory#4", /tiene que ser de tetraimpacts\/sitio-web-project-memory/],
    ["Memoria: tetraimpacts/no-existe#4", /tiene que ser de tetraimpacts\/sitio-web-project-memory/],
  ];
  for (const [cuerpo, motivo] of casos) {
    const api = mundo({ prs: { "tetra-v2#7": prDeCodigo(cuerpo) } });
    const r = await verificar({ api, org: ORG, repo: "tetra-v2", numero: 7, autorizados: [] });
    assert.equal(r.ok, false, cuerpo);
    assert.match(r.motivo, motivo);
  }
});

test("falla si el PR de memoria no existe o se cerró sin fusionar", async () => {
  const cuerpo = "Memoria: tetraimpacts/sitio-web-project-memory#4";
  let api = mundo({ prs: { "tetra-v2#7": prDeCodigo(cuerpo) } });
  let r = await verificar({ api, org: ORG, repo: "tetra-v2", numero: 7, autorizados: [] });
  assert.match(r.motivo, /No existe el PR/);
  api = mundo({
    prs: {
      "tetra-v2#7": prDeCodigo(cuerpo),
      "sitio-web-project-memory#4": { state: "closed", merged: false, body: "" },
    },
  });
  r = await verificar({ api, org: ORG, repo: "tetra-v2", numero: 7, autorizados: [] });
  assert.match(r.motivo, /cerrado sin fusionar/);
});

test("no-aplica solo para bots, release y autorizados", async () => {
  const cuerpo = "Memoria: no-aplica";
  const casos = [
    [{}, [], false],
    [{ user: { login: "dependabot[bot]", type: "Bot" }, body: "sin línea" }, [], true],
    [{ head: { ref: "dev" }, base: { ref: "main" } }, [], true],
    [{ head: { ref: "otra" }, base: { ref: "main" } }, [], false],
    [{}, ["Alguien"], true],
  ];
  for (const [extra, autorizados, ok] of casos) {
    const api = mundo({ prs: { "tetra-v2#7": prDeCodigo(cuerpo, extra) } });
    const r = await verificar({ api, org: ORG, repo: "tetra-v2", numero: 7, autorizados });
    assert.equal(r.ok, ok, JSON.stringify(extra));
  }
});

test("sin rama de trabajo no hay PR de release", async () => {
  const api = mundo({
    prs: { "tetra-kit-v2#3": prDeCodigo("Memoria: no-aplica", { head: { ref: "dev" }, base: { ref: "main" } }) },
  });
  const r = await verificar({ api, org: ORG, repo: "tetra-kit-v2", numero: 3, autorizados: [] });
  assert.equal(r.ok, false);
});

test("un repo renombrado antes que su cabecera se encuentra por id", async () => {
  const api = mundo({
    renombres: { "viejo-ocr": "naat-ocr" },
    prs: {
      "naat-ocr#1": prDeCodigo("Memoria: tetraimpacts/naat-project-memory#8"),
      "naat-project-memory#8": MEMORIA_ABIERTA,
    },
  });
  const r = await verificar({ api, org: ORG, repo: "naat-ocr", numero: 1, autorizados: [] });
  assert.equal(r.ok, true);
});

test("un repo fuera de la noosfera pasa con aviso", async () => {
  const api = mundo({ prs: { "suelto#1": prDeCodigo("nada") } });
  const r = await verificar({ api, org: ORG, repo: "suelto", numero: 1, autorizados: [] });
  assert.equal(r.ok, true);
  assert.match(r.aviso, /no está declarado/);
});

test("la API lee el PR fresco y sigue renombres", async () => {
  const vistas = [];
  const falso = async (url, opciones) => {
    vistas.push([url, opciones.headers.Authorization, opciones.redirect]);
    if (url.endsWith("/repos/tetraimpacts/x")) return { status: 200, ok: true, json: async () => ({ id: 5, default_branch: "main" }) };
    if (url.endsWith("/repos/tetraimpacts/x/pulls/2"))
      return {
        status: 200,
        ok: true,
        json: async () => ({ state: "open", merged: false, body: "b", base: { ref: "main" }, head: { ref: "h" }, user: { login: "u", type: "User" } }),
      };
    return { status: 404, ok: false, json: async () => ({}) };
  };
  const api = apiDeGitHub({ token: "t", org: ORG, manifiesto: {}, fetch: falso });
  assert.deepEqual(await api.repo("x"), { id: 5, default_branch: "main" });
  assert.deepEqual(await api.repo("X"), { id: 5, default_branch: "main" });
  assert.equal(await api.repo("y"), null);
  assert.equal((await api.pr("x", 2)).body, "b");
  assert.equal(vistas.filter(([u]) => u.endsWith("/repos/tetraimpacts/x")).length, 1);
  assert.ok(vistas.every(([, a, r]) => a === "Bearer t" && r === "follow"));
});

test("main: sale con 0 o 1 y escribe el resumen", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cuerpos = { 7: "Memoria: tetraimpacts/sitio-web-project-memory#4", 8: "sin enlace" };
  const servidor = createServer((pedido, respuesta) => {
    const u = pedido.url;
    const json = (d) => {
      respuesta.writeHead(200, { "content-type": "application/json" });
      respuesta.end(JSON.stringify(d));
    };
    if (pedido.headers.authorization !== "Bearer prueba") return respuesta.writeHead(401).end();
    if (u === "/repos/tetraimpacts/tetra-v2") return json({ id: 1, default_branch: "main" });
    if (u === "/repos/tetraimpacts/sitio-web-project-memory") return json({ id: 10, default_branch: "main" });
    const m = /^\/repos\/tetraimpacts\/tetra-v2\/pulls\/(\d+)$/.exec(u);
    if (m && cuerpos[m[1]])
      return json({ state: "open", merged: false, body: cuerpos[m[1]], base: { ref: "dev" }, head: { ref: "x" }, user: { login: "u", type: "User" } });
    if (u === "/repos/tetraimpacts/sitio-web-project-memory/pulls/4")
      return json({ state: "open", merged: false, body: "Código: tetraimpacts/tetra-v2#7" });
    respuesta.writeHead(404).end();
  });
  await new Promise((listo) => servidor.listen(0, "127.0.0.1", listo));
  const dir = mkdtempSync(join(tmpdir(), "tetra-memoria-"));
  writeFileSync(join(dir, "tetra.json"), JSON.stringify(MANIFIESTO));
  const correr = (numero) =>
    new Promise((listo) => {
      const resumen = join(dir, `resumen-${numero}.md`);
      writeFileSync(resumen, "");
      const hijo = spawn(process.execPath, [new URL("./verificar.mjs", import.meta.url).pathname], {
        env: {
          PATH: process.env.PATH,
          GITHUB_REPOSITORY: "tetraimpacts/tetra-v2",
          GITHUB_API_URL: `http://127.0.0.1:${servidor.address().port}`,
          GITHUB_STEP_SUMMARY: resumen,
          PR_NUMERO: String(numero),
          GH_TOKEN: "prueba",
          TETRA_MANIFIESTO: join(dir, "tetra.json"),
        },
      });
      let salida = "";
      hijo.stdout.on("data", (d) => (salida += d));
      hijo.on("close", (codigo) => listo({ codigo, salida, resumen: readFileSync(resumen, "utf8") }));
    });
  try {
    const bien = await correr(7);
    assert.equal(bien.codigo, 0, bien.salida);
    assert.match(bien.resumen, /PR pareado con tetraimpacts\/sitio-web-project-memory#4/);
    const mal = await correr(8);
    assert.equal(mal.codigo, 1);
    assert.match(mal.salida, /::error::Falta la línea/);
    assert.match(mal.resumen, /Falta la línea/);
  } finally {
    servidor.close();
  }
});
