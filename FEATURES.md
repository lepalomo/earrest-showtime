# Catálogo de Funcionalidades — EarRest

Inventário de tudo que existe hoje, levantado diretamente do código em
2026-10-20. Serve como rede de segurança para a sanitização/refatoração: nenhum
item desta lista pode se perder sem decisão explícita.

O ecossistema é dividido em dois apps que compartilham a pasta de dados
(`STEMIZER_DATA_DIR`):

- **Stemizer** (`../earrest`): captura/processamento. Baixa áudio do YouTube,
  separa stems, detecta acordes/BPM, gera variações de tom, TTS de notas.
  Banco SQLite (`earrest.db`), fila de processamento (`worker.py`).
- **Showtime** (`./`): reprodução ao vivo. PWA offline-first que toca os stems,
  mixa, aplica loop/trim/tom/velocidade, metrônomo, notas e setlists.

Os dois conversam pela LAN (Showtime na porta 7001, Stemizer na 7000). Os stems
são servidos em `/stems/<youtube_id>/...` pelos dois servidores (mesma pasta).

---

## SHOWTIME

### Arquivos
- `server.js` — servidor Express (HTTPS se houver cert), API de sync e notas.
- `public/app.js` — toda a lógica do cliente (IIFE única, ~4700 linhas).
- `public/index.html` — markup das 5 views + CSS.
- `public/sw.js` — service worker (cache offline-first, background sync).
- `public/manifest.json` — manifesto PWA.
- `e2e/*.spec.js` — testes Playwright (mobile/tablet/desktop).

### Views (navegação inferior, 5 abas)
1. **Biblioteca** (`library-view`) — playlists e músicas baixadas; drill-down
   em playlist; tocar playlist inteira / shuffle.
2. **Player** (`player-view`) — reprodução com mixer, timeline, acordes, tools.
3. **Setlist** (`setlist-view`) — visão de palco da setlist, fullscreen.
4. **Fila** (`queue-view`) — "Tocando agora", reordenável.
5. **Sync** (`sync-view`) — catálogo do servidor, download/remoção, storage.

### Player — reprodução de áudio
- Reprodução **multi-stem sincronizada** via Web Audio (um `<audio>` +
  `MediaElementSource` + `GainNode` por stem, todos somados num master gain).
- **Pool de áudio persistente** (`audioPool`): reaproveita os nós entre músicas
  (troca só o `src`) — robusto com tela bloqueada / background throttling.
- **Boundary checker** e **resyncStems**: correção de deriva entre stems e
  aplicação de loop/trim durante a reprodução.
- Transport: play/pause, seek na timeline, próxima/anterior.
- **MediaSession API**: metadados + controles de tela de bloqueio + position
  state.
- **Visibility handling**: resume do AudioContext e re-sync ao voltar do
  background; pausa trabalho visual quando escondido.
- Estado de carregamento por stem (progresso de buffering).

### Player — mixer
- Mute / Solo / Volume por stem.
- **Volume master** + **mute master**.
- **Ganho por música** (`songGain`, ±, 50%–300%) — nivela músicas; persiste e
  sincroniza (sobrevive a reprocessamento, guardado em `chords.json`).
- Carrossel de stems no mixer mobile.

### Player — ferramentas (tools, carrossel paginado)
- **Pitch / tom**: selecionar entre variantes já geradas (Original, ±N) **e**
  solicitar geração de um novo tom ao Stemizer (`requestPitchGeneration`,
  com polling de progresso e pré-cache). `getPitchedUrl` mapeia a URL da
  variante.
- **Velocidade** (`setSpeed`): playback rate preservando o tom.
- **Loop A/B** (`setLoopA/B`, `clearLoop`): laço entre dois pontos.
- **Trim** (`setTrimBefore/After`, `clearTrim`): corta início/fim efetivos.
- **Metrônomo**: liga/desliga, sons (`click`/`wood`/`cowbell`/`beat`), volume,
  agendamento por Web Audio alinhado ao tempo de mídia.
- **Tap tempo** (`handleTapTempo`): define BPM batendo, ancora a fase do beat.
- **Editor de BPM** inline (teclado, scroll, drag vertical).
- **Alinhamento visual de beat** (`showBeatAlignModal`): canvas com waveform do
  stem escolhido (bateria por padrão) + envelope do clique por beat; arraste
  para alinhar; inputs de offset(ms)/BPM; play/pause e metrônomo dentro do
  modal; cache de waveform em localStorage.
- **Seções de BPM** (`showBpmSectionsModal`): BPM variável por trecho da música
  (`bpmSections`).
- **Repeat mode** (`cycleRepeat`): off / uma / todas.
- **Presets** por música (`savePreset`/`loadPreset`/`deletePreset`,
  localStorage): salva combinação de mix/tools.

### Player — notas e acordes
- **Barra de acordes** sincronizada (`updateChordBar`).
- **Timeline com waveform** de fundo (`renderTimelineWaveform`), refletindo
  mute/solo (`redrawTimelineWaveform`), marcadores de nota.
- **Notas de execução** por música: adicionar/listar/editar/apagar texto
  ancorado no tempo (`showAddNoteModal`, `showNotesListModal`, `checkNotes`,
  `showNoteDisplay`, marcadores na timeline).
- **TTS das notas** (`requestNotesTTS`): pede ao Stemizer gerar áudio das notas;
  toca o áudio da nota no tempo certo (`notesAudioEnabled`).
- Edição inline de **título/artista** (`initTitleEditor`).
- Edição do **tom (originalKey)** via key picker (12 maiores + 12 menores +
  limpar), compartilhada entre player e setlist.

### Setlist
- Seletor de setlist; render em ordem de posição.
- **Modo fullscreen** (`setlist-fullscreen`); modais montam dentro do elemento
  fullscreen (`mountOverlay`).
- Mostra tom e BPM por música; ambos editáveis inline (modais).
- **Anotações de setlist** (`setlistNotes`): texto livre entre músicas, com
  posição fracionária; cross-device (sincronizam via servidor).
- Reordenar músicas e notas por drag-and-drop (`initSetlistDragDrop`,
  `applySetlistReorder`), persistindo ordem no servidor.
- **Colapsar/esconder** músicas na tela (visual-only, localStorage).

### Fila ("Tocando agora")
- Fila persistente (localStorage): `setQueue`, `queuePlayNext` ("tocar a
  seguir"), `queueAppend` ("adicionar ao final"), remover, limpar, reordenar
  (drag-and-drop).
- Tocar playlist inteira ou shuffle preenche a fila sem alterar a playlist.

### Sync / offline
- **Offline-first**: dados locais no IndexedDB (stores `songs`, `playlists`,
  `playlistSongs`, `pendingEdits`, `setlistNotes`).
- Catálogo do servidor (`/api/catalog`); **download/remoção** de playlists e
  músicas (cache de stems via service worker).
- **Pending edits** fila local sincronizada quando online (`addPendingEdit`,
  `flushPendingEdits`). Tipos: `title`, `artist`, `bpm`, `beatOffset`, `gain`,
  `bpmSections`, `notes`, `originalKey`, `playlistOrder`.
- **Setlist notes sync** (`pushSetlistNotes`/`pullSetlistNotes`) — cross-device
  via JSON no servidor.
- Detecção de conectividade (ping periódico + `online/offline`), badge offline.
- Configurações por música (localStorage `showtime_song_*`): loop, trim, bpm,
  beatOffset, songGain.
- Configurações por playlist (localStorage `showtime_pl_*`): metrônomo, notas,
  repeat, speed, volumes/mute/solo do mixer.
- Info de **armazenamento** (tamanho do cache, quota).

### PWA / Service Worker (`sw.js`)
- Caches separados: app shell, stems, respostas de API.
- Stems: cache-first com suporte a **range requests**.
- API: cache-first com revalidação em background.
- Mensagens: `SKIP_WAITING`, `CACHE_STEMS` (com progresso), `PURGE_STEMS`,
  `GET_CACHE_SIZE`.
- **Background Sync** (`sync` → `syncPendingEdits`).

### Diversos
- Atalhos de teclado (desktop) + FAB de ajuda (`initKeyboardShortcuts`,
  `showShortcutsModal`).
- Toasts, modais de confirmação, action sheets.
- Logo = hard refresh (limpa caches do app).

### API do servidor Showtime (`server.js`)
- Middleware **LAN-only** em `/api` (bloqueia IPs não locais).
- `GET /api/ping` — probe de conectividade.
- `GET /api/catalog` — playlists/músicas/stems disponíveis no servidor.
- `GET /api/sync` — pull completo (inclui `setlistNotes`).
- `POST /api/sync` — recebe pending edits e grava no `chords.json` / DB do
  Stemizer (abre o DB em modo escrita só para isso).
- `GET /api/songs/:id/stems` — URLs dos stems (com `?pitch=N`).
- `GET /api/storage` — tamanho total no servidor.
- `GET/POST /api/setlist-notes` — notas de setlist (JSON compartilhado).
- Estáticos: `/stems`, app shell, `manifest.json` (no-cache).

---

## STEMIZER

### Arquivos
- `server.js` — API de gestão (playlists, músicas, processamento).
- `worker.py` — worker de processamento (fila → download → separação → acordes).
- `scripts/` — `pitch-shift.py`, `detect_chords.py`, `detect_bpm.py`,
  `generate_notes_stem.py`, `benchmark_separation.py`, `check-playlists.js`.
- `db.js`, `public/` (UI web de gestão), `.kiro/docs/` (docs — desatualizados).
- ⚠️ `public/app.js.bak` (319 KB) — resíduo do monolito, candidato a remoção.

### Worker (`worker.py`)
- `pick_job` / fila: pega o próximo item `queued` da tabela `queue`.
- `download_audio`: baixa o áudio do YouTube (yt-dlp).
- `separate_stems`: separação em stems (Demucs/afins).
- `validate_stems` / `_clean_stems_preserve_metadata`: valida e limpa,
  preservando `chords.json`, notas e variantes de pitch.
- `get_audio_duration`, `update_progress`, `complete_job`, `process_job`.

### Processamento / detecção (endpoints)
- `POST /api/songs/:id/pitch` — gera variante(s) de tom (semitons) via
  `pitch-shift.py`; `DELETE` remove variantes.
- `POST /api/songs/:id/detect-chords`, `POST /api/playlists/:id/detect-chords`,
  `POST /api/detect-chords-all` — detecção de acordes.
- `DELETE /api/songs/:id/chord` — remove acorde.
- `POST /api/songs/:id/detect-bpm`, `POST /api/playlists/:id/detect-bpm`.
- `POST /api/songs/:id/reprocess`, `POST /api/playlists/:id/reprocess`.
- `GET /api/task-status` — progresso da tarefa em background (`bgTasks`).

### Notas / TTS
- `GET /api/songs/:id/notes`, `PUT /api/songs/:id/notes` — texto das notas.
- `POST /api/songs/:id/notes/audio` (raw), `DELETE .../notes/audio/:filename`
  — áudio TTS das notas.
- `GET /api/tts` — geração de TTS.

### Biblioteca / playlists / fila
- `GET/POST /api/playlists`, `DELETE /api/playlists/:id`.
- `PUT /api/playlists/order`, `PUT /api/playlists/:id/order` — ordenação.
- `POST /api/playlists/:id/sync`, `POST /api/playlists/local`.
- `POST/DELETE /api/playlists/:id/songs[/:songId]`.
- `GET /api/songs`, `GET /api/songs/:id`, `DELETE /api/songs/:id`.
- `GET /api/playlists/:id/setlist` — metadados musicais da setlist.
- `GET/POST/DELETE /api/queue[/:songId]` — fila de processamento.
- `POST /api/songs/:id/download-mix` — download de um mix renderizado.

### Armazenamento / manutenção
- `GET /api/storage/orphans`, `POST /api/storage/cleanup`,
  `GET /api/storage/stats`, `POST /api/storage/cleanup-pitches`.
- `GET /api/stats` — estatísticas gerais.
- `POST /api/nuke`, `GET /reset` — reset/limpeza.

### UI web de gestão (`public/app.js`)
- Adicionar música por URL / colar várias URLs do YouTube
  (`addUrl`, `extractYoutubeUrls`).
- Render de playlists/músicas; reordenar músicas (drag); swipe-to-delete.
- Picker de biblioteca (`openLibraryPicker`), popup de música.
- Conectividade real (`checkRealConnectivity`) + fila offline de ações
  (`offlineQueue`, `syncPendingLocalData`).
- Estatísticas (`fetchStats`).

---

## Pontos de atenção para a sanitização
- **Showtime `public/app.js`** é uma IIFE única enorme — principal alvo de
  modularização. Agrupamentos naturais: IDB/sync, áudio/mixer, tools
  (pitch/loop/trim/metrônomo/beat-align/bpm), notas/acordes, setlist, fila,
  sync/catálogo, UI/eventos.
- **Duplicação entre apps**: `toast`, `switchView`, lógica de waveform,
  conectividade e offline queue existem nos dois `app.js`.
- **Resíduos**: `public/app.js.bak` no Stemizer; docs `.kiro/docs/` do Stemizer
  desatualizados (pré-split).
- **IndexedDB versão 3**: mudanças de schema exigem bump de versão + migração.
- **Contratos a preservar**: tipos de pending edit, formato do `chords.json`,
  esquema de URL dos stems (`/stems/<id>/pitch_±N/<file>`), mensagens do SW.
