# Changelog

## [0.2.0](https://github.com/fabkho/pi-multifix/compare/pi-multifix-0.1.0...pi-multifix-0.2.0) (2026-04-28)


### ⚠ BREAKING CHANGES

* rename commands /bugfix → /multifix, /bugfix-done → /multifix-done

### Features

* /bugfix-done command — merge MRs, update ClickUp, optional comment ([4dba6bc](https://github.com/fabkho/pi-multifix/commit/4dba6bc29d8bae14623802ba4a42d9ab875ae2f2))
* config loader + YAML schema + anny example config ([#2](https://github.com/fabkho/pi-multifix/issues/2)) ([2c97c96](https://github.com/fabkho/pi-multifix/commit/2c97c968b79191ce40738794c073ee40700c032b))
* create_mr and update_issue pi tools ([#7](https://github.com/fabkho/pi-multifix/issues/7), [#8](https://github.com/fabkho/pi-multifix/issues/8)) ([e1b9907](https://github.com/fabkho/pi-multifix/commit/e1b9907ed9bcbd7b2e3f55cee1ca9550fcb331a3))
* issue adapter interface + ClickUp + headless adapters ([#3](https://github.com/fabkho/pi-multifix/issues/3)) ([c0ad3ee](https://github.com/fabkho/pi-multifix/commit/c0ad3ee46e447ce7035333289f83561765e39eb9))
* manual MR URL injection via /bugfix-status, prepare for public release ([eafff52](https://github.com/fabkho/pi-multifix/commit/eafff52bd84b38c9437b1e8a6742ac7d2ada12ba))
* pi extension shell with /bugfix command + scout agent ([#6](https://github.com/fabkho/pi-multifix/issues/6), [#9](https://github.com/fabkho/pi-multifix/issues/9)) ([392d2c4](https://github.com/fabkho/pi-multifix/commit/392d2c4105b31c17eeb16398253b2f4997ea18fc))
* **prompt:** template renderer + default system prompt ([#5](https://github.com/fabkho/pi-multifix/issues/5)) ([3ec92d7](https://github.com/fabkho/pi-multifix/commit/3ec92d77a4b64e5a8dd36dc16697651a91c0beaa))
* proper pi package, session naming, state persistence, status line, peer deps ([133ea4f](https://github.com/fabkho/pi-multifix/commit/133ea4f40aac2833633391169693dc6138077d83))
* rename commands /bugfix → /multifix, /bugfix-done → /multifix-done ([5e282eb](https://github.com/fabkho/pi-multifix/commit/5e282ebc5ac3d2045eba7025839354aa31afef57))
* workspace creation with worktree + custom script support ([#4](https://github.com/fabkho/pi-multifix/issues/4)) ([c707239](https://github.com/fabkho/pi-multifix/commit/c707239defb9f33a6dd5ca0e851f717163c7cc9a))


### Bug Fixes

* branch starts with CU-&lt;id&gt; (no fix/ prefix) for ClickUp automation ([b627c8f](https://github.com/fabkho/pi-multifix/commit/b627c8f96bef1d3cb9a89db385ae077bc771d89c))
* lazy token resolution — sources shell env if process.env is missing ([850eee2](https://github.com/fabkho/pi-multifix/commit/850eee2d91db776950032dc7fcd3180063b4d321))
* pass --repo to glab mr merge for correct project context ([daa4479](https://github.com/fabkho/pi-multifix/commit/daa44791dd4f73e16d11ba8620ba865e163c8039))
* pre-release review fixes ([3ca08d7](https://github.com/fabkho/pi-multifix/commit/3ca08d78bb658794b818ba4b36db2ee5b8afa43b))
* prefix branch names with CU- for ClickUp automation triggers ([228daf9](https://github.com/fabkho/pi-multifix/commit/228daf934f196570cee0cf3be56579cbd10982bc))
* prune stale worktree refs before creating new ones ([826e15a](https://github.com/fabkho/pi-multifix/commit/826e15ad6a5acebcd64ad256c0bbbe26ecdcbe53))
* remove --fill from glab, catch MR URLs from bash fallback ([b442a62](https://github.com/fabkho/pi-multifix/commit/b442a62322ae59f1baf12410d492b08053d025eb))
* remove workspace script from anny config — use generic worktree mode ([ed242c8](https://github.com/fabkho/pi-multifix/commit/ed242c8abf4ac0af8e8ce478d23d7614ced851f1))
* symlink node_modules + vendor into worktrees for MCP/tool compat ([d802095](https://github.com/fabkho/pi-multifix/commit/d80209549ff0bee82e9078c92e97e14f814fe76b))
* track MR URLs from tool_result details, handle missing merge rights gracefully ([5423bd0](https://github.com/fabkho/pi-multifix/commit/5423bd0c54426936b03a90523e79f51b58cb575e))
* use pi.exec() for all shell commands — prevents event loop blocking ([aadda70](https://github.com/fabkho/pi-multifix/commit/aadda700e0e7878948cd03b5bdc62757e77c82a1))
* workspace script compat — use CU-&lt;id&gt;_&lt;name&gt; format, detect existing dirs ([cb08518](https://github.com/fabkho/pi-multifix/commit/cb0851862dfa7405022e21c6566baf259139beff))
