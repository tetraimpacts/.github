// node --test tetra-seguridad/

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { armadura, firmaValida, lineaSeguridad, verificar } from "./verificar.mjs";

const ORG = "tetraimpacts";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const POLITICA = JSON.parse(readFileSync(new URL("./politica.json", import.meta.url), "utf8"));
const TOML = Buffer.from('title = "reglas"\n');

function comprobante(extra = {}) {
  return {
    formato: "tetra-seguridad/1",
    repo: "tetraimpacts/tetra-noosfera",
    repo_id: 1,
    head: HEAD,
    base: null,
    herramientas: { gitleaks: "8.30.1", "osv-scanner": "2.7.0" },
    reglas: {
      "gitleaks.toml": createHash("sha256").update(TOML).digest("hex"),
      gitleaksignore: "por-defecto",
    },
    excepciones: null,
    osv_base: "en-linea",
    conteos: { gitleaks: { secretos: 0 }, "osv-scanner": { critica: 0, alta: 0, media: 3, baja: 0, sin: 0 } },
    huellas: "e3b0",
    cumple: true,
    fecha: "2026-11-10T12:00:00Z",
    autor: "alguien",
    ...extra,
  };
}

/** Como lo serializa tetra: claves ordenadas y sin espacios. */
function canonico(v) {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function linea(texto, firma = null) {
  return `cumple, sin firmar, 0123456: resumen <!-- tetra-seguridad/1 ${Buffer.from(texto).toString("base64")} ${firma ?? "-"} -->`;
}

function mundo({ cuerpo, head = HEAD, user = { login: "alguien", type: "User" }, llaves = {}, autorCommit = "alguien" }) {
  return {
    async repo(nombre) {
      return nombre === "tetra-noosfera" ? { id: 1 } : null;
    },
    async pr(nombre, numero) {
      return nombre === "tetra-noosfera" && numero === 3 ? { body: cuerpo, head: { sha: head }, user } : null;
    },
    async autorDelCommit() {
      return autorCommit;
    },
    async archivo(_nombre, ruta) {
      return ruta === ".gitleaks.toml" ? TOML : null;
    },
    async llavesDeFirma(login) {
      return llaves[login] ?? [];
    },
  };
}

const correr = (api, firmaValida) =>
  verificar({ api, org: ORG, repo: "tetra-noosfera", numero: 3, politica: POLITICA, ...(firmaValida && { firmaValida }) });

/** Una llave nueva y lo que firma con ella, como `tetra seguridad`. */
function conLlave(fn) {
  const dir = mkdtempSync(join(tmpdir(), "prueba-firma-"));
  try {
    const llave = join(dir, "llave");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", llave]);
    const publica = readFileSync(`${llave}.pub`, "utf8").split(/\s+/).slice(0, 2).join(" ");
    let n = 0;
    const firmar = (texto, espacio = "tetra-seguridad") => {
      // ssh-keygen no pisa un .sig que ya existe: cada firma, su archivo.
      const archivo = join(dir, `c${n++}.json`);
      writeFileSync(archivo, texto);
      execFileSync("ssh-keygen", ["-Y", "sign", "-q", "-f", llave, "-n", espacio, archivo]);
      return readFileSync(`${archivo}.sig`, "utf8")
        .split("\n")
        .filter((l) => l && !l.startsWith("-----"))
        .join("");
    };
    return fn({ publica, firmar });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("lee la última línea Seguridad: y su comprobante oculto", () => {
  const texto = canonico(comprobante());
  assert.deepEqual(lineaSeguridad(`x\nSeguridad: viejo\n\nMemoria: a#1\nSeguridad: ${linea(texto, "QUJD")}`), {
    tipo: "comprobante",
    formato: "tetra-seguridad/1",
    canonico: texto,
    firma: "QUJD",
  });
  assert.equal(lineaSeguridad(`Seguridad: ${linea(texto)}`).firma, null);
  assert.deepEqual(lineaSeguridad("Seguridad: cumple"), { tipo: "invalida" });
  assert.deepEqual(lineaSeguridad(null), { tipo: "falta" });
});

test("arma la firma en líneas de 70", () => {
  const a = armadura("A".repeat(150));
  assert.equal(a, `-----BEGIN SSH SIGNATURE-----\n${"A".repeat(70)}\n${"A".repeat(70)}\n${"A".repeat(10)}\n-----END SSH SIGNATURE-----\n`);
});

test("sin firma pasa con aviso", async () => {
  const r = await correr(mundo({ cuerpo: `Memoria: x#1\nSeguridad: ${linea(canonico(comprobante()))}` }));
  assert.deepEqual(r.problemas, []);
  assert.match(r.avisos[0], /sin firmar/);
  assert.match(r.resumen, /0123456, sin firmar/);
});

test("firmado con la llave del autor pasa sin aviso", () =>
  conLlave(async ({ publica, firmar }) => {
    const texto = canonico(comprobante());
    const api = mundo({ cuerpo: `Seguridad: ${linea(texto, firmar(texto))}`, llaves: { alguien: [publica] } });
    const r = await correr(api);
    assert.deepEqual(r.problemas, []);
    assert.deepEqual(r.avisos, []);
    assert.match(r.resumen, /firmado por alguien/);
  }));

test("falla la firma de otra llave, de otro espacio o de un comprobante editado", () =>
  conLlave(async ({ publica, firmar }) => {
    const texto = canonico(comprobante());
    const otra = conLlave(({ publica: p }) => p);
    const editado = canonico(comprobante({ fecha: "2026-11-11T00:00:00Z" }));
    const casos = [
      [linea(texto, firmar(texto)), { alguien: [otra] }],
      [linea(texto, firmar(texto, "git")), { alguien: [publica] }],
      [linea(editado, firmar(texto)), { alguien: [publica] }],
    ];
    for (const [l, llaves] of casos) {
      const r = await correr(mundo({ cuerpo: `Seguridad: ${l}`, llaves }));
      assert.equal(r.problemas.length, 1, l);
      assert.match(r.problemas[0], /La firma no es de ninguna llave/);
    }
  }));

test("solo vale la firma del autor del PR o del último commit", async () => {
  const texto = canonico(comprobante({ autor: "intrusa" }));
  const api = mundo({ cuerpo: `Seguridad: ${linea(texto, "QUJD")}`, llaves: { intrusa: ["ssh-ed25519 AAAA"] } });
  const r = await correr(api, () => true);
  assert.match(r.problemas[0], /Lo firmó intrusa/);
  const deCommit = await correr({ ...api, autorDelCommit: async () => "intrusa" }, () => true);
  assert.deepEqual(deCommit.problemas, []);
  const sinLlaves = await correr({ ...api, autorDelCommit: async () => "intrusa", llavesDeFirma: async () => [] }, () => true);
  assert.match(sinLlaves.problemas[0], /no tiene llaves de firma/);
});

test("falla sin línea, con otro head, otro repo, otras reglas o versiones", async () => {
  const casos = [
    ["Sin comprobante", HEAD, /Falta la línea «Seguridad:»/],
    ["Seguridad: cumple", HEAD, /no lleva el comprobante/],
    [`Seguridad: ${linea(canonico(comprobante()))}`, "f".repeat(40), /del commit 0123456 y el PR va en fffffff/],
    [`Seguridad: ${linea(canonico(comprobante({ repo_id: 9 })))}`, HEAD, /de otro repo/],
    [`Seguridad: ${linea(canonico(comprobante({ reglas: { "gitleaks.toml": "x", gitleaksignore: "por-defecto" } })))}`, HEAD, /reglas de \.gitleaks\.toml/],
    [`Seguridad: ${linea(canonico(comprobante({ herramientas: { gitleaks: "8.0.0", "osv-scanner": "2.7.0" } })))}`, HEAD, /gitleaks 8\.0\.0 no es una versión aceptada/],
    [`Seguridad: ${linea("{no es json")}`, HEAD, /no es JSON/],
  ];
  for (const [cuerpo, head, motivo] of casos) {
    const r = await correr(mundo({ cuerpo, head }));
    assert.ok(r.problemas.length >= 1, cuerpo);
    assert.match(r.problemas[0], motivo);
  }
});

test("aplica la política de resultado y no se fía del campo cumple", async () => {
  const conteos = { gitleaks: { secretos: 0 }, "osv-scanner": { critica: 1, alta: 0, media: 0, baja: 0, sin: 0 } };
  let r = await correr(mundo({ cuerpo: `Seguridad: ${linea(canonico(comprobante({ conteos, cumple: false })))}` }));
  assert.deepEqual(r.problemas, ["No cumple la política: 0 posibles secretos y 1 avisos critica o alta en dependencias."]);
  r = await correr(mundo({ cuerpo: `Seguridad: ${linea(canonico(comprobante({ conteos })))}` }));
  assert.match(r.problemas[0], /campo cumple/);
});

test("los PR de bots pasan", async () => {
  const r = await correr(mundo({ cuerpo: "", user: { login: "dependabot[bot]", type: "Bot" } }));
  assert.deepEqual(r.problemas, []);
  assert.match(r.avisos[0], /bot/);
});
