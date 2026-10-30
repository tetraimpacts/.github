# .github de Tetra

Archivos comunes de la organización. Repo público: no lleva nombres de clientes ni datos
de ningún proyecto.

- `pull_request_template.md`: la plantilla de PR de todos los repos que no tienen una
  propia.
- `.github/workflows/tetra-memoria.yml` y `tetra-memoria/verificar.mjs`: el check del PR
  pareado (contrato tetra-memoria/2, sección 2.21, en tetra-noosfera). Lo exige el ruleset
  «PR pareado» de la organización en los repos de código; no se copia a ningún repo.

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

Pruebas:

```
node --test tetra-memoria/verificar.test.mjs
```
