# Frontend architecture (agentic_ui)

`agentic_ui` is organised **feature-first**: code is grouped by *what it does for
the user* (a feature/domain), not by *what kind of file it is*. A feature owns its
components, hooks, and handlers together; only genuinely cross-cutting code lives
in a shared layer. This replaced the earlier layer-first layout (`components/`,
`hooks/`, `handlers/`, `runtime/`), where a single `components/chat/` folder had
become a catch-all for ~10 unrelated features and nothing told you, per page,
what belonged to it.

The organising rule — and the answer to "shared or dedicated?":

> Used by **≥2 features** → it is **shared** (`shared/`). Used by **exactly one**
> feature → it lives **inside that feature** (dedicated). Don't pre-share; promote
> a module to `shared/` the moment a *second* feature imports it, and move it then.

## Directory layout

```text
src/
  main.tsx  App.tsx  error_boundary.tsx   # composition root (routing + providers)
  index.css                  # entry point only — an ordered @import list, no rules
  vite-env.d.ts
  styles/                    # the actual CSS, split by domain
    theme/                                #   design tokens, one file per theme + themes.ts registry (see its README)
    base.css                              #   reset, body, shared transition utils
    voice-transitions.css                 #   the stacked chat/voice body panels
    composer.css  orb.css                 #   the composer's light; the AI orb (shared/ui/orb.tsx) per state
    skeleton.css  toast.css  markdown.css scrollbars.css  misc.css

  app/                       # the persistent workspace shell (App.tsx's layout route)
    WorkspaceShell.tsx       #   sidebar, search, profile/dialog modals, the <Outlet/> slot
    useChatWorkspace.tsx     #   builds the workspace bundle once per render
    workspaceContext.ts      #   the route views' accessor for that bundle (a React context)
    useIncognitoCard.ts

  pages/                     # one file per route — composes a feature, wires routing
    ChatView.tsx             #   "/" and "/c/:id"
    AutomationsView.tsx      #   "/automations" (?agent= / ?template= open the create form)
    LegacyTasksRedirect.tsx  #   "/tasks" → "/automations", query kept (one release)
    AgentsView.tsx           #   "/agents…" — layout over the chat; the agents pages render in its outlet
    ArtifactsView.tsx        #   "/artifacts" — every file of the user's, across conversations (plan 44)
    Login.tsx  SharedConvPage.tsx
    TermsAndConditions.tsx  PrivacyPolicy.tsx
    NotFound.tsx  ErrorPage.tsx

  features/                  # one folder per feature; owns components/ hooks/ handlers/
    agents/        # the Agents section: gallery, agent page (Overview/Tools/Approvals/
                   #   Memory/History), the builder; pages/ (AgentsGallery, AgentPage,
                   #   AgentBuilderPage), hooks (useAgentTools, useMemories, …), lib/
    chat/          # conversation rendering + chat handlers/hooks + sidebar
      components/  #   ChatBody, ChatMessage, ChatInputBar, ChatHeader, ChatSidebar,
                   #   AgentRunTimeline, HitlInputTakeover, ComposerTaskNotices,
                   #   message_parts/* (incl. the async-task parts: TaskTreeCards,
                   #   TaskRefBlockView, TaskSettledMarker, TaskNoticeRow, MessageTaskTree,
                   #   TaskStopButton; TaskSidePanel in RunSidePanels; AnswerSourcesPanel)
      lib/         #   pure helpers, e.g. taskTreeAdapter (task tree → sub-agent cards),
                   #   sources (the citation source registry: durable + events + live,
                   #   plan 42), citationText (markers → [1] + "Sources:" for Copy),
                   #   answerSources (an answer's sources: pointed-at first, then More),
                   #   canvasOpener (the context ChatView provides so ArtifactCard can open a
                   #   presented `.md` in the canvas; absent on a share, so no button there —
                   #   the user bubble's CanvasEditChip, plan 44 Phase 4.3, opens through it too)
      hooks/       #   useChatEffects, useActiveRunBranchSnap, useConversationRail,
                   #   useKeyboardShortcuts, useTaskClock, useConversationSources,
                   #   useAnswerSources
      handlers/    #   conversations, messages, shortcuts, ui
    inference/     # the AG-UI run engine: agui, timeline, inference, hitl(+context),
                   #   useInferenceRuns, useRunTimeline, inferenceErrors, index (barrel);
                   #   async sub-agent tasks (plan 41): taskTree (the conversation-level
                   #   tree fold), useBackgroundTasks (tree + conversation channel + task
                   #   streams + composer queue), backgroundTasks-context
    automations/   # the Automations page (plan 38): AutomationsPage, automations_parts/*
                   #   (AutomationCard, ScheduleForm, AutomationFormDialog, AutomationToolbar,
                   #   TemplateSection, TemplateCard, EmptyState, ErrorState), hooks/useAutomations,
                   #   lib/ (kinds registry, filters, templates, task status, routes, styles)
    settings/      # ProfilePanel (ChatGPT-taxonomy settings modal on the premium dark
                   #   shell), EditProfileDialog, ShortcutsPanel + HelpPanel (dedicated
                   #   modals, not settings tabs), profile_parts/* (General/Personalization
                   #   (+CustomInstructionsDialog)/Voice/Usage/Security/DataControls/Account
                   #   real tabs + ComingSoon stubs + Skills/Mcp workspace tabs),
                   #   useProfilePanel, useSkills, useCatalogueSearch, usePlatformSkills
                   #   (read-only Platform page: PlatformSkillsView), useUsageSummary,
                   #   preferences handler
    sharing/       # SharePanel + share handler
    reporting/     # ReportPanel + report handler
    search/        # SearchPanel + search handler
    voice/         # VoiceModeBody + useChatVoiceMode + useRealtimeVoiceSession + voice handler
    attachments/   # AttachmentPreviewPanel + attachment_preview_parts/* + attachment handler
    artifacts/     # the Artifacts page (plan 44): ArtifactsPage (heading, pinned toolbar, date-grouped
                   #   files), artifacts_parts/* (ArtifactList — the virtualized grid / list;
                   #   ArtifactCard + ArtifactCover, ArtifactRow, ArtifactActions (dock + ⋯ menu),
                   #   ArtifactsToolbar, ArtifactsStates, FileStackArt), hooks (useUserFiles — keyset
                   #   pages of GET /v1/attachments/files; useArtifactActions — preview/download through
                   #   features/attachments' panel + ImageLightbox; useArtifactsView — Grid / List,
                   #   remembered; useDebouncedValue, useLoadMoreSentinel), lib/ (routes: ARTIFACTS_PATH;
                   #   fileFilters — filters, family accents, date groups, ages; fileView — one file's
                   #   display fields); a generated `.md` opens in the canvas of its conversation (`/c/:id?doc=`)
    canvas/        # the document canvas (plan 44, Phases 4.1–4.6 + v2): CanvasDock (docks the
                   #   canvas beside the chat at ~55%, resizable; covers the chat full screen, on a
                   #   phone and below a 760px card), DocumentCanvas (the panel, lazy-loaded so
                   #   Plate and the diff stay out of the main chunk; one session per document,
                   #   keyed by path), canvas_parts/* (CanvasHeader: the ▾ document switcher,
                   #   the save status (nothing once saved), Export, full screen, close;
                   #   CanvasExportPanel (version picker, Word / PDF / Markdown rows, Copy as Markdown, unsaved note); CanvasDocumentView, the Plate
                   #   editor — editable at the latest version, read-only at an earlier one;
                   #   CanvasDocBar (≡, Find, undo / redo, the resolved / detached comments button, the Editing / Suggesting / Viewing menu; marks the agent writing here); CanvasToolbar, the floating pill
                   #   toolbar adapted from Plate's registry (block tools, icon-only: Aa▾, table,
                   #   checklist, quote, ⋯ More (lists, code block, block actions), comment, and a
                   #   filled Ask agent (selection or the caret's block); on touch with a selection
                   #   the marks + link replace the block tools; keeps the selection on touch, rises
                   #   above a phone's keyboard);
                   #   CanvasFormatControls (the controls the pill and the selection bar share:
                   #   text style, the four marks, checklist, list menu + ListMenuItems, link);
                   #   CanvasSelectionMenu (the desktop's floating selection bar, icon-only,
                   #   `@platejs/floating` like Plate's registry floating-toolbar: comment, Ask
                   #   agent (the orb) | Aa▾ B I S code | list▾ link; Comment alone while reading).
                   #   Canvas icons are Phosphor regular (`react-icons/pi`, imported one by one); CanvasCaretOrb (the app's
                   #   orb at the caret's line after an idle wait: Ask agent for that block);
                   #   CanvasComments (the comment threads as cards under their margin marks
                   #   (CanvasCommentMarkers): replies, resolve / reopen, edit / delete, detached,
                   #   Resolved (n), "Agent is working on this…"); CanvasCommentForm (the composer,
                   #   with the "@agent" suggestion and the token tinted); CanvasAgentMention (the
                   #   agent's orb avatar, the token in shown bodies); CanvasCommentButton (the pill's comment icon, and on touch a
                   #   Comment bar while reading); CanvasAskPanel (CanvasAskCard: the compact
                   #   "Ask the agent to change this…" input with the presets as chips, shared by
                   #   the bar, the orb and the pill's popover); CanvasTablePicker (the size grid); CanvasBlockMenu
                   #   (the ⋮⋮ handle + block menu: Delete / Duplicate / Move / Turn into, also the
                   #   lower half of the pill's ⋯ menu);
                   #   CanvasTableElement (a table + its floating row / column / delete toolbar);
                   #   CanvasSaveStatus (+ CanvasAgentEditingStatus while Ask agent's run goes);
                   #   CanvasUnsavedDialog (Save / Discard / Cancel; Save and send / Cancel
                   #   before Ask agent; Save and export / Export the saved version / Cancel);
                   #   CanvasHistory (side panel, a sheet on a phone: read / compare / restore;
                   #   opened from the byline's version chip); CanvasCompareView (the
                   #   word-level diff); CanvasConflictDialog (the 409); CanvasOutline, CanvasFindBar,
                   #   CanvasBlockFrame (heading folds, the block handle, the selected-block tint,
                   #   a suggested added / removed block or line break);
                   #   CanvasSuggestionBar (Suggesting mode — the user's edits as suggestions:
                   #   "N suggestions", Accept all / Reject all, the ✓ / ✕ pill per suggestion);
                   #   CanvasSuggestionLeaf (suggested inserted / deleted / formatted words),
                   #   CanvasByline, CanvasStates (skeleton, error +
                   #   Retry, 404 → the file's preview, the earlier-version, "agent saved vN" and
                   #   stale-suggestions banners)), hooks (useCanvasDocument — the documents reads
                   #   through TanStack Query; useCanvasEditing — the save controller and the
                   #   suggestion saver of the open document (one Save: a version, then the set),
                   #   the editor's source text, the reload-or-banner rule for a newer version
                   #   (pending suggestions carried onto it, or set aside as stale);
                   #   useCanvasVersionText; useCanvasRoute — `?doc=<path>` in the URL;
                   #   useKeyboardInset — the on-screen keyboard's overlap, from visualViewport;
                   #   useSelectedPassage — the passage Ask agent would act on;
                   #   useCaretOrb — where the orb at the caret shows (idle, focused, no selection);
                   #   useCanvasComments — the threads, optimistic with rollback, refresh at run end;
                   #   useRequestedThread — the thread a chat card asked the canvas to open;
                   #   useCanvasExport — one export at a time, download + toast;
                   #   useCanvasSuggestions — the pending suggestion set read on open: drawn,
                   #   rebased onto the latest, stale, or cleared), lib/
                   #   (saveController — saved only on the user's Save, single flight, base version, 409 → conflict;
                   #   markdown — the markdown ⇄ Plate value pipeline, no MDX, plus normalizeMarkdown;
                   #   documentDiff — jsdiff lines refined to words; suggestions — around Plate's
                   #   @platejs/suggestion (live tracking in editorKit): the two texts a value
                   #   stands for (all rejected / all accepted), a saved set drawn word by word,
                   #   the list, accept / reject on the editor, the jsdiff rebase; suggestionSaver —
                   #   PUT / DELETE of the set, single flight, a moved base saved again; modeStorage —
                   #   the remembered mode (localStorage); editorCommands — quote, link
                   #   and the link URL rule; blockCommands — the target blocks (block selection or
                   #   the text selection's), delete / duplicate / move / turn into, table insert
                   #   and the table toolbar's actions; editorDelete — Backspace / Delete across
                   #   tables, rules, images, code; pasteCleanup — Word / web HTML cleaned before
                   #   Plate reads it; selectionMemory — the selection a toolbar tap remembers and
                   #   puts back; toolbarControls — the controls' shared look and press handlers;
                   #   askAgent — the passage (text, heading path; a whole block's for the orb),
                   #   the presets and the `canvasEdit` request; caretOrb — the caret line's
                   #   height, the block's noun; askHighlight — the passage's tint (CSS Custom
                   #   Highlight API); commentAnchors — quote + context capture and finding it
                   #   again (detached when gone); commentHighlight — the threads' passages
                   #   painted with the Custom Highlight API; agentMention — `@agent` as a word,
                   #   the instruction without it, the suggestion's query / completion; agentWriting —
                   #   the run's edit_file / write_file on the open document, from the live timeline;
                   #   pendingThread — chat card → open a thread (like pendingShine);
                   #   commentAgentContext; shortcuts; queryKeys; editorKit (with Plate's BlockSelection
                   #   and SuggestionPlugin, plus Enter in a heading as a suggested line break),
                   #   canvasView, outline, find, documentTitle, dates, bylineContext, canvasFile)
    auth/          # useSessionEffects + auth handler (Login page stays in pages/)
    catalog/       # agents handler (agent/tool discovery)

  shared/                    # cross-cutting, feature-agnostic (imports NOTHING from features)
    ui/                      # design system — shadcn base + ai-elements + react_bits + shadcn-io
                             #   (ai-elements/inline-citation: the citation pill + card, plan 42;
                             #   site-icon: a source's favicon from our own origin;
                             #   plate/: the canvas editor's node components, from Plate's
                             #   shadcn registry; SectionBoundary: a section's error boundary)
    lib/                     # api, http, schemas, types, consts, utils + persistence
                             #   (authStorage, uiStateStorage, cookieConsentStorage), shortcuts,
                             #   schedule + workflowSchedule (schedule wording / preview shared
                             #   by Automations → Schedules and the workflow builder),
                             #   citations + remarkCitations + citations-context (inline
                             #   citation markers, the remark plugin, the sources context),
                             #   siteIcons (favicon host + failed-host memo), canvasDocuments
                             #   (which files are canvas documents: `sourcePath ?? "/conversation/
                             #   output/" + name`, `.md` only; the `?doc=` URL; a document's
                             #   title and a passage's chip excerpt)
    stores/                  # workspaceStore (Zustand)
    hooks/                   # use-mobile, use-toast (framework-generic), useSessionUserId,
                             #   useResizablePanel (a dockable right-hand panel's width: the agent
                             #   builder's inspector and the document canvas), useTouchMenuTrigger
                             #   (a finger opens a Radix menu on the tap's click: the chat sidebar,
                             #   the effort picker, the Artifacts page's touch menu)

```

## Layering rules

1. **Dependency direction is one-way:** `app/pages → features → shared`.
   `shared/` never imports from `features/`; features never import from `app/`
   or `pages/`. `app/` and `pages/` are the composition layer: the shell renders
   `ChatView`, and the route views read the shell's bundle through
   `app/workspaceContext`.
2. **`shared/` is feature-agnostic.** If you want to import a feature's type into
   `shared/`, either the type belongs in `shared/` or the dependency is inverted.
3. **Pages are thin** — compose a feature and wire routing. No `fetch`, no business
   logic. The shell's own wiring lives in `app/`, not in a page.
4. **Colocation + promote-on-second-use.** One consumer = dedicated (lives in the
   feature); a second consumer = move it to `shared/`.
5. **`@/` is the only alias**, mapped to `src/` (vite + tsconfig). Imports read
   `@/features/<f>/…` and `@/shared/…`. Prefer absolute `@/` imports over deep
   relative chains.
6. **Barrels are for outside consumers; inside a folder, deep-import the leaf.**
   `shared/lib/{api,types,consts}` are folders whose `index.ts` re-exports the
   domain modules, so all ~110 importing files keep a single stable import path.
   A module *within* one of those folders must import its sibling directly
   (`from "./agents"`), never `from "."` — a barrel self-import is a real cycle.
   Same rule across folders: `types/preferences.ts` reaches into
   `consts/personalization` (a leaf), not the `consts` barrel. This is what
   dissolved the pre-existing `types ↔ consts` cycle, which had been survivable
   only because both directions happened to be type-only and got erased.

## Shared vs dedicated (the current verdict)

- **Shared** (`shared/`): the design system (`shared/ui`), the data-contract +
  transport layer (`shared/lib`: `api`/`http`/`schemas`/`types`), utils/consts,
  persistence, `workspaceStore`, and the framework-generic hooks (`use-mobile`,
  `use-toast`). The one cross-feature *component* dependency is the chat message
  renderer (`features/chat/components/message_parts/Content`), consumed by
  `features/sharing` (SharePanel) and the public-share page.
- **Dedicated**: everything under a `features/<feature>/` folder is used by exactly
  that feature. This is what makes "what does `/automations` own?" answerable — it's
  `features/automations/`, nothing else.

## Inline citations (plan 42)

The answer's `[src:ID]` markers become citation pills. The pieces sit on both
sides of the `shared/` boundary, so the dependency direction holds:

| Piece | File | Role |
| --- | --- | --- |
| Marker grammar | `shared/lib/citations.ts` | The contract regex, id parsing, hostname, `hideUnclosedCitationMarker` (streaming), code-aware `replaceCitationMarkers` |
| Remark plugin | `shared/lib/remarkCitations.ts` | Marker → `mx-citation` element with `data-ids`; skips code, math, HTML, link text |
| Components | `shared/ui/ai-elements/inline-citation.tsx` | AI Elements' `InlineCitation` family on our `HoverCard`; `SourceCitation` resolves ids, drops unknown ones, renders nothing when none is known |
| Sources context | `shared/lib/citations-context.ts` | `CitationSourcesContext` (a `Map<id, CitationSource>`), read by the pill; empty outside a provider |
| Contract + API | `shared/lib/schemas.ts` (`CitationSourceSchema`, `ConversationSourcesSchema`), `types/citations.ts`, `api/citations.ts` (`getConversationSources`) | http(s) URLs only, capped text; a bad entry is dropped, never the list |
| Run fold | `features/inference/timeline.ts` | `SOURCES` events (top-level or in `SUBAGENT_EVENT`) → `RunTimeline.sources`; `collectRunSources(events)` reads a log without folding it |
| Registry | `features/chat/lib/sources.ts` + `hooks/useConversationSources.ts` | Durable list (TanStack Query; a share's frozen `sources` instead) + settled messages' events + background-task timelines + the live run; reloads when a run ends or a task notification arrives |
| Copy | `features/chat/lib/citationText.ts` | Markers → `[1]`, `[2]` by first appearance + a `Sources:` list; used by `ChatMessage`, `answerGroupText` and a sub-agent card's copy |
| Search step chips | `features/chat/components/message_parts/SourceCards.tsx` | A tool step whose `SOURCES` event names pages (`TimelineToolExecution.sources`, attached by `tool_call_id`) shows them as compact chips (`aria-label="Sources"` list): the site icon + the page title (truncated) or its host, the whole chip a safe link, full title + host in its tooltip — for any search tool. Its `TOOL_CALL_RESULT` arrives empty: the page contents never reach the browser |
| Site icon | `shared/ui/site-icon.tsx` + `shared/lib/siteIcons.ts` + `api/favicons.ts` (`faviconUrl`) + `shared/hooks/useSessionUserId.ts` | A 14–16px favicon from **our own origin only** (`GET /api/v1/favicons/{user_id}?host=…`, the bridge fetches and caches it; lazy, async, no referrer, decorative). User id from the workspace store (signed in, not pending deletion); no user (public share page) or a load error → the site's initial on a muted tile (drawn by CSS, so it never joins copied text). Failed hosts are remembered for the session. Used by the chips, the citation pill, the pill's card and the Sources panel |
| Answer Sources panel | `features/chat/lib/answerSources.ts` + `hooks/useAnswerSources.ts` + `message_parts/AnswerSourcesPanel.tsx` | "Sources" in an answer's More menu (`AIActionBar`, only when it has any) opens a right Sheet for the whole answer group: first the sources its members' `[src:…]` markers point at (first appearance, resolved via the registry, unknown ids dropped), no heading; then "More" — the rest of the union of the members' `SOURCES` events (+ the bar message's timeline), 8 shown, "N more" reveals the others. http(s) only, no repeats by id or URL |

The renderers opt in: `Response citations` (agent answers: `ContentBlockView`,
an AI `MessageContent`) and `MarkdownRenderer citations` (off by default, so an
attachment preview or a person's text is never rewritten). The provider sits in
`app/WorkspaceShell` (from `useChatWorkspace`) and on `pages/SharedConvPage`.

## Known transitional state

The former `pages/ChatPage.tsx` shell is gone: `App.tsx` mounts
`app/WorkspaceShell` as a layout route around `/`, `/c/:id`, `/automations`,
`/agents…`, `/workflows/…` and `/artifacts`, so the shell never unmounts while the URL picks the view in its
`<Outlet/>`. The workspace bundle reaches the views through a React context
(`app/workspaceContext.ts`), not a store slice — the file's header explains why.

The former `src/handlers/index.ts` aggregator is **gone**. It re-exported the
feature handler modules so the shell could keep a single `@/handlers` import;
the shell now imports each handler from the feature that owns it, which is what
makes the dependency direction visible at the import site.

Also pending (low priority): per-feature `index.ts` **barrels** as the public
import surface, then routing cross-feature imports through them instead of deep
paths.

## Code splitting and delivery (plan 45)

The first download carries only the chat. Everything else is its own chunk,
loaded when it is first needed and warmed in the background once someone is
signed in.

| What | How | Where |
| --- | --- | --- |
| Route pages (Agents and its pages, Automations, Artifacts, Workflows, Login, Share, Terms, Privacy, Not found) | `React.lazy` over one loader per page; `ChatView` and `LegacyTasksRedirect` stay eager | `app/routeLoaders.ts`, `App.tsx` |
| Waiting for a chunk | `<Suspense fallback={<PageFallback/>}>`: around the routes in `App.tsx` (full screen), the shell's outlet and the Agents outlet (`overlay`, over the chat, sidebar still usable) | `shared/ui/page-fallback.tsx` |
| Settings, file preview | Always-mounted panels become lazy, mounted the first time they open and then kept (their close animation and state are unchanged) | `app/WorkspaceShell.tsx` |
| Charts in answers | `LazyChartCard`: recharts loads with the first chart; a skeleton holds its place | `features/chat/components/message_parts/LazyChartCard.tsx` |
| Prefetch | `prefetchRouteChunks()` runs once signed in, on `requestIdleCallback` (Safari: a short timeout), one chunk after another, failures ignored | `app/routeLoaders.ts` |
| Vendor chunks | `react`, `radix`, `data` (TanStack Query, Zod, Zustand) split by `manualChunks`, so they stay cached across releases. Only libraries the first page loads anyway may join a group | `vite.config.ts` |
| Agent icons | An explicit `AGENT_ICONS` map, never `import * as Icons` (that shipped all of Lucide). A new icon choice is added to the map too; `agent-icons.test.ts` checks the picker, templates and platform agents | `shared/lib/consts/icons.ts` |

**Delivery (nginx).** The Dockerfile writes a `.gz` beside every text asset and
nginx serves it with `gzip_static` (`gzip on` covers the rest; every `/api/`
location keeps `gzip off`). Hashed files under `/assets/` are cached for a year
(`immutable`) and a missing one is a real 404; `/brand/` images for a day;
`index.html` is `no-cache`. The browser security headers live in
`security-headers.conf`, included by the server block **and** by every location
that sets its own `Cache-Control`: nginx's `add_header` does not merge, so a
location that adds a header without that include would serve the app with no
CSP or HSTS.

**Rendering while a run streams.** A run event arrives about once per token, so
everything it touches keeps its identity when the event changes nothing:
`patchRowById` (the sidebar list) and `nextLiveThinkingState` (the thinking
state) in `features/inference/runState.ts` return the previous value, and the
current conversation is only replaced when a message, a summary or the run's
flags change. Effects depend on the facts they need (`Boolean(conversation)`,
"draft is empty"), never on the conversation object or the draft text. Objects
handed to memoized children or to a context (`Streamdown`'s `mermaidConfig` and
`components`, `MarkdownRenderer`'s renderers, the `HitlProvider` value) are
module constants or `useMemo`, and window listeners read the latest handlers
through a ref and register once (`useKeyboardShortcuts`).

On top of that (Phase 3): run state reaches React at most once per animation
frame (see `docs/flows/inference-streaming.md` § Phase 7). `ChatMessage` is
memoized, comparing the two branch switchers field by field; `ChatBody` hands
the rows stable callbacks from `useStableHandlers` (`shared/hooks/`) — never for
callbacks a row calls while rendering, like `resolveMessageAgent` — and gives
the live thinking state and the edit draft only to the message that reads them.
`TimelineSequence` gives each `CoTBlock` a stable toggle per block key. While an
answer ends inside an open code block, `Response` hands Streamdown its text at
most every 150 ms (`useCodeFenceThrottle`), since each change re-highlights the
whole block; prose is never held back.

**Typing and the shell (Phase 4).** The composer's draft lives in the workspace
store (`draft` / `setDraft`), not in the shell: `useComposer` (which runs in
the shell) reads only `draftIsEmpty` and hands out `getCurrentMessage()` for
handlers to read when they run; `DraftComposer` is the one component subscribed
to the text (with the slash menu), and the textarea's auto-grow lives in
`ChatInputBar` with it. A keystroke therefore re-renders the input bar only.
`ChatSidebar` is memoized; the shell gives it stable callbacks from
`useStableHandlers` and a memoized context-meter render prop. `requestPersist`
is a debounced call, not state. A new piece of state that changes per keystroke
or per token belongs in the store with selector readers, or below the shell —
never in `useChatWorkspace`'s own state.

**Data loading (Phase 5).** The `QueryClient` defaults to `staleTime: 30_000`,
no refetch on window focus, `retry: 1`; the canvas's mutable queries opt back
to `staleTime: 0`. The session bootstrap reads the IndexedDB snapshot in
parallel with the session restore and raises `sessionReady` before the five
catalogs load, so a deep-linked conversation's detail request starts at once.
Conversation details are cached per user in the `QueryClient`
(`features/chat/lib/conversationDetailCache.ts`, key `['conversation', userId,
id]`, painted from cache for 30 s, at most 12 per user) and only ever hold what
the server sent — a conversation changed on screen is dropped when you leave
it. The sidebar prefetches on hover/focus with 150 ms intent
(`usePrefetchConversation`). The query cache is cleared on logout, account
switch and any change of the signed-in user. Search aborts the previous request;
automations skip polls in a hidden tab and keep the same array when nothing
changed; workflows reload on tab return at most every 30 s.

**Bundle and paint (Phase 6).** One syntax highlighter: shiki, through the
shared `shared/lib/highlighter.ts` (grammars on demand, 200-entry LRU); thoughts
and secondary markdown are not highlighted. KaTeX and `rehype-raw` (parse5) are
lazy chunks: a build-only Vite plugin (`lazyStreamdownPlugins` in
`vite.config.ts`) points Streamdown's imports at `shared/lib/lazyRehype*.ts`, and
`useLazyRehypePlugins` remounts an answer once if it was drawn before a plugin
it needed had loaded. The greeting's SplitText and `ShimmeringText` are CSS
(no gsap, no `motion`). Rotating glows (composer, live cards: `LiveBorder`)
turn a pre-blurred element with `transform` and run only while focused, busy or
active; the orb renders a still image below 32 px and its WebGL loop is capped
at 30 fps with one decoded image per URL. Long lists are virtualized through
`shared/hooks/useVirtualList.ts`: the sidebar's Chats above 60 rows (memoized
`ConversationRow`), Artifacts always. Automation and workflow cards animate
layout only for 1.5 s after a change the user made, never on a poll. Rule: an
infinite or per-frame animation must be compositor-only (`transform`,
`opacity`) and paused when its element is inactive.

**Rules.** A new route page is lazy (add its loader to `routeLoaders.ts`, and to
the prefetch order if people open it often). A heavy library used by one panel
or block loads with that panel, not in the entry chunk. Reach into a `*_parts`
folder's light leaf (e.g. `attachment_preview_parts/registry`) rather than its
barrel when the barrel re-exports heavy components.

## Adding to the frontend

- New endpoint/contract → `shared/lib/` (`api.ts` + a schema in `schemas.ts`). See
  [dialogue-bridge-reference.md] and the API-contract notes.
- New feature → create `features/<feature>/{components,hooks,handlers}/`, keep it
  self-contained, and only reach into `shared/` (or another feature's public
  surface) — never the reverse.
- New shared primitive → `shared/ui` (shadcn) via `npx shadcn@latest add` (the
  `components.json` aliases point `ui`/`lib`/`utils`/`hooks` at `shared/`).
- A component/hook/handler used by a second feature → move it to `shared/`.
