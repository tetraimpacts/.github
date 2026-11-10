# .github de Tetra

Archivos comunes de la organización. Repo público: no lleva nombres de clientes ni datos
de ningún proyecto.

- `pull_request_template.md`: la plantilla de PR de todos los repos que no tienen una
  propia.
- `.github/workflows/tetra-memoria.yml` y `tetra-memoria/verificar.mjs`: el check del PR
  pareado (contrato tetra-memoria/2, sección 2.21, en tetra-noosfera). Lo exige el ruleset
  «PR pareado» de la organización en los repos de código; no se copia a ningún repo.
- `.github/workflows/tetra-seguridad.yml`, `tetra-seguridad/verificar.mjs` y
  `tetra-seguridad/politica.json`: el check del comprobante de seguridad (plan 0001 de la
  plataforma). Lo exige un ruleset de la organización; no se copia a ningún repo.

## El check del PR pareado

Cada PR de código lleva su PR en la memoria del proyecto. El check lee el PR por la API
(nunca del evento) y pasa si la última línea `Memoria:` de su descripción enlaza un PR
abierto o fusionado de la memoria del nodo que declara el repo, según el manifiesto
`generado/tetra.yaml` del central. Compara repos por id, así un renombre no lo rompe.

- `Memoria: no-aplica` vale solo para los PR de release (de la rama de trabajo del repo a
  su rama principal) y para quien esté en la variable de organización
  `TETRA_MEMORIA_AUTORIZADOS`, separados por comas. Los PR de bots pasan siempre.
- Un repo que ninguna cabecera declara pasa con un aviso: los repos nuevos no quedan
  bloqueados.
- Usa el token de la App tetra-memoria (variable `TETRA_MEMORIA_CLIENT_ID`, secreto
  `TETRA_MEMORIA_LLAVE`), con permisos de solo lectura. No escribe nada.
- GitHub corre los workflows de un ruleset solo al abrir, empujar o reabrir un PR. Después
  de editar la descripción, `tetra pr` vuelve a correr el check; a mano, «Re-run».

## El check del comprobante de seguridad

GitHub no escanea: verifica. `tetra seguridad` escanea en la máquina de la persona el
último commit de la rama (gitleaks y osv-scanner) y `tetra pr` deja su comprobante
`tetra-seguridad/1` en la última línea `Seguridad:` de la descripción, con un resumen
visible y el comprobante en un comentario HTML. El check lee el PR por la API y comprueba:

- que el comprobante es de este repo (por id) y del head actual del PR;
- que las versiones de las herramientas están en `tetra-seguridad/politica.json`, que
  cambia una persona por PR;
- que el hash de `.gitleaks.toml` y `.gitleaksignore` es el de ese commit;
- que cumple la política: ningún posible secreto ni aviso crítico o alto en dependencias,
  recalculado de los conteos sin fiarse del campo `cumple`;
- si viene firmado, que lo firmó el autor del PR o del último commit con una llave de firma
  SSH que GitHub publica de él (`ssh-keygen -Y verify`, espacio de nombres
  `tetra-seguridad`). Sin firma pasa con un aviso visible en el check.

Con la variable de organización `TETRA_SEGURIDAD_MODO` en `bloquea`, un problema hace
fallar el check; con cualquier otro valor, o sin ella, solo avisa. Los PR de bots pasan.
Usa el mismo token de solo lectura de la App tetra-memoria. Todavía no repite el escaneo
al azar: lo hace una pieza posterior del plan.

Pruebas:

```
node --test tetra-memoria/verificar.test.mjs
node --test tetra-seguridad/verificar.test.mjs
```
