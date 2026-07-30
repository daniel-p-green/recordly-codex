# MCP protocol v0.5.0

Frozen tool surface for marketplace installs of Recordly Codex `0.5.0`. Additive-only until a new minor version.

| # | Tool | Stage | Mutating |
| ---: | --- | --- | --- |
| 1 | `create_recording_session` | Capture | yes |
| 2 | `record_browser_event` | Capture | yes |
| 3 | `inspect_recording_session` | Capture | no |
| 4 | `seal_recording_capture` | Capture | yes |
| 5 | `discard_recording_session` | Capture | yes (destructive) |
| 6 | `create_recording_project` | Project | yes |
| 7 | `inspect_recording_project` | Project | no |
| 8 | `revise_recording_project` | Project | yes |
| 9 | `render_recording_project_preview` | Project | yes |
| 10 | `render_recording_project_final` | Project | yes |
| 11 | `inspect_recording_project_preview` | Preview QA | no |
| 12 | `judge_recording_project_preview` | Preview QA | yes |
| 13 | `import_recording_project_media` | Media | yes |
| 14 | `list_recording_profiles` | Profiles | no |
| 15 | `get_recording_profile` | Profiles | no |
| 16 | `create_recording_profile` | Profiles | yes |
| 17 | `update_recording_profile` | Profiles | yes |
| 18 | `apply_recording_profile` | Profiles | yes |
| 19 | `propose_recording_project_editorial` | Editorial | no |
| 20 | `apply_accepted_recording_project_editorial` | Editorial | yes |

Production wiring (`createSessionStoreService` → `createRecordingMcpServer`) must expose all 20. Partial registration is allowed only in unit tests that inject a narrowed `RecordingMcpService`.

Input schemas live in `mcp/schemas.ts`. Do not rename tools or narrow accepted fields in a patch release.
