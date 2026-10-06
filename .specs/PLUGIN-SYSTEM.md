# Система плагинов: справочник для авторов

Справочник по системе плагинов Ru Code для разработчика плагина: что такое плагин, как его установить и выключить, какие точки расширения есть у приложения, что плагин получает в контексте, какие действуют лимиты, как собрать, протестировать, запустить в песочнице и поставить плагин. Все типы и сигнатуры приведены дословно из исходного кода SDK (`@smart-tools/plugin-sdk`) и пакета разработки (`@smart-tools/plugin-dev`); комментарии исходников в блоках типов опущены.

## Содержание

- [1. Что такое плагин](#plugin)
  - [Манифест plugin.json](#manifest)
  - [Серверная часть, веб-часть, стили](#halves)
  - [Точки входа пакетов](#entries)
- [2. Установка и переключение](#install)
  - [Два корня](#roots)
  - [Включение и выключение](#switches)
  - [Состояния и диагностика](#states)
- [3. Точки расширения (швы)](#seams)
  - [pages — страница на своём маршруте](#seam-pages)
  - [panels — правый слот или вкладка диалога](#seam-panels)
  - [composer.items — строки меню `/`, `$`, `#`](#seam-composer)
  - [background — невидимые постоянные компоненты](#seam-background)
  - [activate / deactivate (веб)](#seam-web-lifecycle)
  - [rpc — методы серверной части](#seam-rpc)
  - [session — участие в жизненном цикле сессии](#seam-session)
  - [migrations — схема собственной SQLite](#seam-migrations)
  - [activate / deactivate (сервер)](#seam-server-lifecycle)
- [4. Веб-контекст WebCtx](#webctx)
  - [Signal и useSignal](#ctx-signal)
  - [pluginId](#ctx-pluginid)
  - [invoke](#ctx-invoke)
  - [state](#ctx-state)
  - [query](#ctx-query)
  - [connection](#ctx-connection)
  - [locale](#ctx-locale)
  - [theme](#ctx-theme)
  - [projects](#ctx-projects)
  - [activeProject](#ctx-activeproject)
  - [provider](#ctx-provider)
  - [toast](#ctx-toast)
  - [invalidate](#ctx-invalidate)
  - [closePanel](#ctx-closepanel)
  - [pickFolder](#ctx-pickfolder)
  - [composer](#ctx-composer)
  - [log](#ctx-log)
  - [assetUrl](#ctx-asseturl)
- [5. Серверный контекст ServerCtx](#serverctx)
  - [storage](#ctx-storage)
  - [projects](#ctx-projects-server)
  - [paths](#ctx-paths)
  - [log](#ctx-log-server)
  - [locale](#ctx-locale-server)
  - [publish](#ctx-publish)
  - [pluginId](#ctx-pluginid-server)
- [6. Ошибки](#errors)
- [7. Лимиты](#limits)
- [8. Общие модули](#shared)
- [9. CSS-скоупинг](#css)
- [10. Сборка](#build)
- [11. Тестирование](#testing)
  - [testing/node — помощники с диском и SQLite](#testing-node)
  - [Конфиг тестов](#testing-config)
- [12. Песочница](#playground)
  - [playground.json](#playground-json)
  - [e2e: pluginE2eConfig](#playground-e2e)
- [13. Поставка](#shipping)

<a id="plugin"></a>

## 1. Что такое плагин

Плагин — это **папка**. Её кладут в `~/.ru-code/plugins/<id>/` или поставляют вместе с приложением. Папка содержит манифест `plugin.json` и до трёх артефактов: серверную часть, веб-часть и таблицу стилей.

```text
<id>/
  plugin.json          манифест — единственный обязательный файл
  server/index.mjs     выполняется в Node-процессе приложения     (необязательно)
  web/index.mjs        выполняется в браузере                     (необязательно)
  web/styles.css       таблица стилей плагина                     (необязательно)
  assets/…             файлы, доступные по URL                    (необязательно)
```

Допустим плагин только с веб-частью и плагин только с серверной частью. Приложение вызывает только то, что плагин экспортирует.

Папка лежит вне любого дерева `node_modules`, поэтому сама по себе не разрешает ни одного «голого» спецификатора:

- **серверная часть** — один файл, в котором из внешних импортов остаются только `node:*`; всё остальное вбандлено;
- **веб-часть** импортирует по имени только [общие модули](#shared), которые приложение публикует через import map (это те же экземпляры React и effect, что у приложения); всё остальное вбандлено;
- **стили** — обычный CSS против токенов приложения (`var(--…)`); сборка ограничивает каждое правило поддеревом плагина ([CSS-скоупинг](#css)).

Серверный плагин выполняется внутри процесса приложения. Защита хранилища — это проверка SQL-операторов, а не песочница: устанавливайте только плагины, которым доверяете.

<a id="manifest"></a>

### Манифест plugin.json

```json
{
  "id": "demo",
  "name": { "en": "Demo", "ru": "Демо" },
  "description": {
    "en": "The SDK's own example: every seam a plugin can export, in one folder you can copy.",
    "ru": "Пример из SDK: все швы, которые может экспортировать плагин, в одной папке для копирования."
  },
  "version": "1.0.0",
  "apiVersion": 2,
  "server": "server/index.mjs",
  "web": "web/index.mjs",
  "styles": "web/styles.css"
}
```

| поле          | тип                    | обязательно | правило                                                                                                                        |
| ------------- | ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | `PluginId`             | да          | равен имени папки; шаблон `PLUGIN_ID_PATTERN`: строчные латинские буквы, цифры и дефис, 2–32 символа, первая — буква           |
| `name`        | `LocalizedText`        | да          | строка или `{ "en": …, "ru": … }` с обоими ключами; показывается в «Настройки ▸ Расширения»                                    |
| `version`     | непустая строка        | да          | показывается рядом с именем, не разбирается                                                                                    |
| `apiVersion`  | целое ≥ 1              | да          | должно равняться `PLUGIN_API_VERSION` (`2`), иначе плагин пропускается с причиной                                              |
| `server`      | `PluginRelativePath`   | нет         | путь к серверной части внутри папки                                                                                            |
| `web`         | `PluginRelativePath`   | нет         | путь к веб-части внутри папки                                                                                                  |
| `styles`      | `PluginRelativePath`   | нет         | путь к таблице стилей внутри папки                                                                                             |
| `description` | `LocalizedText`        | нет         | одна строка под именем в «Настройки ▸ Расширения»; отсутствует — строки нет                                                    |
| `shared`      | `PluginSharedVersions` | нет         | проставляется сборкой: версии общих модулей, с которыми собрана веб-часть; при расхождении мажорной версии плагин пропускается |
| `enabled`     | `unknown`              | нет         | только литерал `false` поставляет плагин выключенным; отсутствие, `true`, строка, число — включён                              |

Пути `server` / `web` / `styles` проверяются при загрузке: непустые, без NUL, не абсолютные, без сегмента `..`, указывают на существующий файл внутри папки — и по лексическому пути, и по реальному (`realPath`); символическая ссылка за пределы папки отклоняется.

Строки `name` и `description` читаются функцией `localizedText`: у объекта берётся ключ текущего языка, затем `en`, затем `ru`; строка обрезается по краям; строка с управляющим символом считается пустой; длиннее `MAX_MANIFEST_TEXT_LENGTH` (200) — усекается. Пустое имя заменяется идентификатором плагина, пустое описание не показывается.

<a id="t-plugin-api-version"></a>

**`PLUGIN_API_VERSION`**

```ts
export const PLUGIN_API_VERSION = 2 as const;
```

<a id="t-plugin-id-pattern"></a>

**`PLUGIN_ID_PATTERN`**

```ts
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
```

<a id="t-pluginid"></a>

**`PluginId`**

```ts
export const PluginId = Schema.String.check(Schema.isPattern(PLUGIN_ID_PATTERN)).pipe(
  Schema.brand("PluginId"),
);
export type PluginId = typeof PluginId.Type;
```

<a id="t-pluginrelativepath"></a>

**`PluginRelativePath`**

```ts
const RELATIVE_PATH_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

export const PluginRelativePath = Schema.String.check(
  Schema.isPattern(RELATIVE_PATH_PATTERN, { title: "PluginRelativePath" }),
);
export type PluginRelativePath = typeof PluginRelativePath.Type;
```

<a id="t-localizedtext"></a>

**`LocalizedText`**

```ts
export const LocalizedText = Schema.Union([
  Schema.String,
  Schema.Struct({ en: Schema.String, ru: Schema.String }),
]);
export type LocalizedText = typeof LocalizedText.Type;
```

<a id="t-max-manifest-text-length"></a>

**`MAX_MANIFEST_TEXT_LENGTH`**

```ts
export const MAX_MANIFEST_TEXT_LENGTH = 200;
```

<a id="t-pluginsharedversions"></a>

**`PluginSharedVersions`**

```ts
export const PluginSharedVersions = Schema.Record(Schema.String, Schema.NonEmptyString);
export type PluginSharedVersions = typeof PluginSharedVersions.Type;
```

<a id="t-pluginmanifest"></a>

**`PluginManifest`**

```ts
export const PluginManifest = Schema.Struct({
  id: PluginId,
  name: LocalizedText,
  version: Schema.NonEmptyString,
  apiVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  server: Schema.optional(PluginRelativePath),
  web: Schema.optional(PluginRelativePath),
  styles: Schema.optional(PluginRelativePath),
  description: Schema.optional(LocalizedText),
  shared: Schema.optional(PluginSharedVersions),
  enabled: Schema.optional(Schema.Unknown),
});
export type PluginManifest = typeof PluginManifest.Type;
```

<a id="t-localizedtext-2"></a>

**`localizedText`**

```ts
export const localizedText = (value: unknown, locale: string): string => { … }
```

<a id="t-manifestenabled"></a>

**`manifestEnabled`**

```ts
export const manifestEnabled = (manifest: { readonly enabled?: unknown }): boolean =>
  manifest.enabled !== false;
```

<a id="halves"></a>

### Серверная часть, веб-часть, стили

Веб-часть — модуль, чей экспорт по умолчанию создан `defineWebPlugin`; серверная часть — модуль, чей экспорт по умолчанию создан `defineServerPlugin`. Обе функции — типизированная идентичность: они ничего не регистрируют, а только проверяют форму объекта. Состав объектов описан в разделе [Точки расширения](#seams).

<a id="t-definewebplugin"></a>

**`defineWebPlugin`**

```ts
export const defineWebPlugin = (plugin: WebPlugin): WebPlugin => plugin;
```

<a id="t-defineserverplugin"></a>

**`defineServerPlugin`**

```ts
export const defineServerPlugin = (plugin: ServerPlugin): ServerPlugin => plugin;
```

```ts
// src/web/index.tsx
import { defineWebPlugin } from "@smart-tools/plugin-sdk/host";

export default defineWebPlugin({
  panels: () => [{ id: "hello", title: "Hello", render: () => <p>Hello</p> }],
});
```

```ts
// src/server/index.ts
import { defineServerPlugin } from "@smart-tools/plugin-sdk/host";

export default defineServerPlugin({
  rpc: { "hello.say": async () => "hello" },
});
```

Таблица стилей подключается приложением как `<link>` в документ приложения; сборка оборачивает её правила в `[data-plugin-root="<id>"]` ([CSS-скоупинг](#css)).

<a id="entries"></a>

### Точки входа пакетов

| импорт                                       | содержимое                                                                                                                              | где используется                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `@smart-tools/plugin-sdk/host`               | все типы, которые пишет автор, и функции `defineWebPlugin`, `defineServerPlugin`, `isPluginRpcError`, `rpcFailure`, `pluginFailureData` | обе части плагина; без runtime-импортов             |
| `@smart-tools/plugin-sdk/react`              | `useSignal`                                                                                                                             | только веб-часть (импортирует общий `react`)        |
| `@smart-tools/plugin-sdk/locale`             | `createLocale`, `createPluginRuntime`                                                                                                   | веб-часть; без импортов                             |
| `@smart-tools/plugin-sdk/contracts`          | схемы `plugin.json` и протокола на `effect/Schema`                                                                                      | приложение; плагин не импортирует (несёт `effect`)  |
| `@smart-tools/plugin-sdk/state`              | правила state- и query-механизмов, их константы                                                                                         | приложение, песочница, фейки; плагин не импортирует |
| `@smart-tools/plugin-sdk/build`              | `pluginBuildConfig` и проверки сборки                                                                                                   | `tsdown.config.ts`, только Node                     |
| `@smart-tools/plugin-sdk/testing`            | фейковые `WebCtx` и `ServerCtx`                                                                                                         | тесты; Node и браузер                               |
| `@smart-tools/plugin-sdk/testing/node`       | помощники тестов, читающие диск и `node:sqlite`                                                                                         | тесты; только Node                                  |
| `@smart-tools/plugin-sdk/tailwind/theme.css` | блок `@theme inline` приложения                                                                                                         | шаг сборки стилей Tailwind                          |
| `@smart-tools/plugin-sdk/tsconfig/*.json`    | пресеты TypeScript                                                                                                                      | `tsconfig.*.json` плагина                           |
| `@smart-tools/plugin-dev/playground`         | `pluginDevConfig`                                                                                                                       | `vite.playground.config.ts`                         |
| `@smart-tools/plugin-dev/e2e`                | `pluginE2eConfig`, фикстура `test`, `expect`                                                                                            | `playwright.config.ts`, e2e-спеки                   |
| `@smart-tools/plugin-dev/test`               | `pluginTestConfig`                                                                                                                      | `vite.config.ts`                                    |

<a id="install"></a>

## 2. Установка и переключение

<a id="roots"></a>

### Два корня

| корень           | где                                                          | чей                                                              |
| ---------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| поставляемый     | внутри пакета версии приложения, `versions/<v>/plugins/<id>` | приложения; заменяется целиком при каждой установке и обновлении |
| пользовательский | `~/.ru-code/plugins/<id>`                                    | пользователя; переживает установки и обновления                  |

**Приоритет.** Сначала сканируется поставляемый корень, затем пользовательский; идентификатор остаётся за первым корнем, который его заявил. Папка пользователя с тем же идентификатором остаётся на месте, коллизия записывается одной строкой в лог, а состояние поставляемого плагина (загружен, сбой, пропущен, выключен) — окончательное. Внутри корня папки обходятся в порядке имён.

**Данные плагина** лежат не в папке плагина, а в `<stateDir>/plugins/<id>/data.sqlite`: удаление папки плагина данные не удаляет.

**Установка** — скопировать папку в `~/.ru-code/plugins/<id>/` и **перезапустить приложение**: приложение сканирует корни один раз при запуске, горячей перезагрузки нет. Удаление — удалить папку и перезапустить.

<a id="switches"></a>

### Включение и выключение

Переключатель в «Настройки ▸ Расширения» записывает `<stateDir>/plugins/disabled.json`. Файл лежит вне обоих корней и переживает установки, обновления и откаты.

```json
{ "disabled": ["analytics"], "enabled": ["project-settings"] }
```

Порядок решения для идентификатора:

- идентификатор есть в `disabled` — плагин выключен;
- иначе идентификатор есть в `enabled` — плагин включён (даже если манифест поставляет его с `"enabled": false`);
- иначе решает манифест: `"enabled": false` — выключен, всё остальное — включён.

Идентификатор в обоих списках — выключен, с предупреждением в логе. Отсутствующий, нечитаемый или неверный по форме файл читается как пустой (ничего не выключено), с записью в лог. Переключатель проверяется **до** того, как из папки что-либо выполняется: у выключенного плагина нет ни импорта, ни открытия хранилища, ни миграций. Уже запущенный плагин работает до перезапуска приложения; выключение не удаляет данные.

<a id="states"></a>

### Состояния и диагностика

<a id="t-pluginstate"></a>

**`PluginState`**

```ts
export const PluginState = Schema.Literals(["loaded", "failed", "skipped"]);
export type PluginState = typeof PluginState.Type;
```

- `loaded` — плагин загружен;
- `failed` — плагин начал загружаться и упал (исключение или превышение времени на шаге, ошибка миграции, сбой `activate`);
- `skipped` — плагин не запускался: неверный манифест, несовпадение `id` и имени папки, другой `apiVersion`, другая мажорная версия общего модуля, выключен пользователем или манифестом.

Проблемы плагина приложение не показывает пользователю тостами. Они попадают в два места: строка `console.debug` в браузере вида `[plugins] <id> <code>: <сообщение>` и запись плагина в «Настройки ▸ Расширения». Повтор той же пары (плагин, код) только увеличивает счётчик.

<a id="seams"></a>

## 3. Точки расширения (швы)

Плагин не вызывает API регистрации: он **экспортирует методы-швы**, а приложение в каждой точке вызывает их у всех плагинов. Каждый вызов изолирован: исключение стоит только этой поверхности этого плагина. Все члены объектов необязательны.

<a id="t-webplugin"></a>

**`WebPlugin`**

```ts
export type WebPlugin = {
  pages?(ctx: WebCtx): ReadonlyArray<Page>;
  panels?(ctx: WebCtx): ReadonlyArray<Panel>;
  composer?: {
    items?(
      trigger: ComposerTrigger,
      query: string,
      ctx: WebCtx,
    ): ReadonlyArray<ComposerRow> | Promise<ReadonlyArray<ComposerRow>>;
  };
  background?(ctx: WebCtx): ReadonlyArray<ComponentType>;
  activate?(ctx: WebCtx): void | Promise<void>;
  deactivate?(ctx: WebCtx): void | Promise<void>;
};
```

<a id="t-serverplugin"></a>

**`ServerPlugin`**

```ts
export type ServerPlugin = {
  readonly migrations?: ReadonlyArray<Migration>;
  readonly rpc?: Readonly<Record<string, RpcHandler>>;
  readonly session?: SessionSeam;
  activate?(ctx: ServerCtx): void | Promise<void>;
  deactivate?(ctx: ServerCtx): void | Promise<void>;
};
```

| шов                       | часть  | когда приложение вызывает                                                     | что делает с ответом                                                                                       |
| ------------------------- | ------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pages`                   | веб    | когда нужен список страниц; по `invalidate("pages")`                          | маршрут `/plugins/<pluginId>/<pageId>` на каждую страницу и необязательная кнопка в подвале боковой панели |
| `panels`                  | веб    | когда нужна поверхность панели; по `invalidate("panels")`                     | глобальный правый слот или вкладка правой панели диалога                                                   |
| `composer.items`          | веб    | пока открыто меню `/` `$` `#`, на каждое нажатие; по `invalidate("composer")` | строки меню; слаг строки `/` попадает в список разрешённых команд                                          |
| `background`              | веб    | после загрузки плагинов; по `invalidate("background")`                        | монтирует невидимые компоненты на всё время жизни страницы                                                 |
| `activate` / `deactivate` | веб    | `activate` — один раз при загрузке                                            | исключение или зависание дольше 10 с — состояние `failed`                                                  |
| `rpc`                     | сервер | при `ctx.invoke` / `ctx.query` из веб-части                                   | ответ уходит в веб-часть как JSON                                                                          |
| `session`                 | сервер | перед сообщением пользователя и перед каждым запуском сессии                  | решает о перезапуске сессии провайдера                                                                     |
| `migrations`              | сервер | при запуске, до `activate`                                                    | применяются к SQLite плагина по порядку, один раз                                                          |
| `activate` / `deactivate` | сервер | при запуске / при остановке сервера                                           | бюджет 15 с на шаг                                                                                         |

Значки (`icon`) вне `render` — это **имена** иконок `lucide-react` (`"Puzzle"`, `"ChartBar"`, `"folder-tree"`). Приложение рисует их своей копией lucide; неизвестное имя рисуется нейтральным значком, без исключения.

<a id="t-iconname"></a>

**`IconName`**

```ts
export type IconName = string;
```

<a id="seam-pages"></a>

### pages — страница на своём маршруте

<a id="t-page"></a>

**`Page`**

```ts
export type Page = {
  readonly id: string;
  readonly title: string;
  readonly icon?: IconName;
  readonly render: ComponentType;
  readonly nav?: PluginNav;
};
```

<a id="t-pluginnav"></a>

**`PluginNav`**

```ts
export type PluginNav = {
  readonly label: string;
  readonly icon?: IconName;
};
```

- `id` — слаг `PLUGIN_SLUG_PATTERN` (`/^[a-z0-9][a-z0-9-]{0,63}$/`), становится сегментом маршрута `/plugins/<pluginId>/<pageId>`; уникален в пределах плагина (повтор отбрасывается, остаётся первое вхождение);
- `title` — строка любой длины (места отрисовки обрезают её сами); страница отбрасывается, только если `title` не строка;
- `render` — компонент без пропсов; приложение монтирует `createElement(render)` внутри границы ошибок и `<Suspense>`;
- `nav` — добавляет кнопку перехода в подвал боковой панели;
- не больше 8 страниц за вызов, лишние отбрасываются.

```ts
import { defineWebPlugin } from "@smart-tools/plugin-sdk/host";
import { NotesPage } from "./NotesPage.tsx";

export default defineWebPlugin({
  pages: () => [
    {
      id: "notes", // → /plugins/<pluginId>/notes
      title: "Notes",
      icon: "NotebookPen",
      render: NotesPage,
      nav: { label: "Notes", icon: "NotebookPen" },
    },
  ],
});
```

<a id="seam-panels"></a>

### panels — правый слот или вкладка диалога

<a id="t-panelmount"></a>

**`PanelMount`**

```ts
export type PanelMount = "panel" | "tab";
```

<a id="t-panel"></a>

**`Panel`**

```ts
export type Panel = {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly icon?: IconName;
  readonly render: ComponentType;
  readonly mount?: PanelMount;
  readonly width?: number;
  readonly nav?: PluginNav;
};
```

- `mount: "panel"` (по умолчанию) — глобальный правый слот приложения: одна панель одновременно, одна и та же на всех экранах; `width` — предпочтительная ширина, ограничивается диапазоном 320–960, перетаскивание пользователя важнее;
- `mount: "tab"` — вкладка правой панели диалога рядом с Diff / Files / Agents: карточка в лаунчере этой панели, вкладка после открытия, закрывается своим ✕ или `ctx.closePanel(id)`. Вкладка — одна на диалог по `id`; смонтирована только активная вкладка активного диалога, поэтому `render` монтируется и размонтируется при переходах, а дорогое состояние хранится в модуле плагина или в `background`. `width` для вкладки игнорируется;
- `mount` может смениться во время работы: приложение перечитывает шов по `ctx.invalidate("panels")`;
- `description` — строка под карточкой лаунчера и в меню «+»; не проверяется: пустая или из пробелов — строки нет, иначе рисуется как есть и обрезается на 1000 символах;
- `id` / `title` / `render` / `nav` — по тем же правилам, что у страницы; не больше 4 панелей за вызов.

```ts
import { defineWebPlugin } from "@smart-tools/plugin-sdk/host";
import { NotesPanel, NotesTab } from "./panels.tsx";

export default defineWebPlugin({
  panels: () => [
    {
      id: "notes",
      title: "Notes",
      icon: "Puzzle",
      render: NotesPanel,
      width: 420,
      nav: { label: "Notes", icon: "Puzzle" },
    },
    {
      id: "notes-tab",
      title: "Notes tab",
      description: "Notes beside the thread",
      icon: "PanelRight",
      mount: "tab",
      render: NotesTab,
    },
  ],
});
```

<a id="seam-composer"></a>

### composer.items — строки меню `/`, `$`, `#`

<a id="t-composertrigger"></a>

**`ComposerTrigger`**

```ts
export type ComposerTrigger = "/" | "$" | "#";
```

<a id="t-composerrow"></a>

**`ComposerRow`**

```ts
export type ComposerRow = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: IconName;
  readonly insert: string;
  readonly group?: string;
};
```

- статические и динамические строки — один и тот же шов: вернуть массив или промис массива;
- `query` — текст после символа-триггера, **не обрезан и может быть `""`**; приложение строки плагина не фильтрует — фильтрует плагин;
- `insert` вставляется **дословно**, завершающий пробел — забота плагина; `insert` — непустая строка;
- слаг строки `/` (начальное `/имя` до первого пробела, в нижнем регистре; допустимы кириллица, точки и двоеточия) попадает в список команд, которые приложение пропускает при отправке; строка, которая была отброшена, — это и команда, которая будет отклонена при отправке; строка сверх 100 не рисуется в меню, но остаётся в этом списке, и набранная вручную команда выполняется;
- `id` — непустая строка (ключ, не отображается); `label` — строка; `group` — строка или отсутствует; `description` не проверяется (как у панели); меню рисует не больше 100 строк плагина за запрос.

```ts
import { defineWebPlugin, type ComposerRow } from "@smart-tools/plugin-sdk/host";

export default defineWebPlugin({
  composer: {
    items: async (trigger, query, ctx) => {
      const rows: ReadonlyArray<ComposerRow> =
        trigger === "/"
          ? [
              {
                id: "notes-context",
                label: "Notes context",
                description: "Insert the notes as context",
                icon: "Puzzle",
                insert: `${await ctx.invoke<string>("context.build")}\n`,
              },
            ]
          : [];
      const needle = query.trim().toLowerCase();
      return needle === "" ? rows : rows.filter((r) => r.label.toLowerCase().includes(needle));
    },
  },
});
```

<a id="seam-background"></a>

### background — невидимые постоянные компоненты

Компоненты монтируются после загрузки плагинов над роутером и не размонтируются: работают при любой навигации и независимо от того, открыта ли поверхность плагина. **Компонент обязан рендерить `null`.** Не больше 2 компонентов. Здесь держат подписку на `ctx.query`, чтобы чтение оставалось актуальным.

```ts
import { defineWebPlugin, type WebCtx } from "@smart-tools/plugin-sdk/host";
import { useEffect } from "react";

let held: WebCtx | null = null;

const KeepNotesFresh = (): null => {
  useEffect(() => held?.query("notes.list").subscribe(() => {}), []);
  return null;
};

export default defineWebPlugin({
  background: (ctx) => {
    held = ctx;
    return [KeepNotesFresh];
  },
});
```

<a id="seam-web-lifecycle"></a>

### activate / deactivate (веб)

`activate` необязателен: каждый шов и так получает контекст. Он выполняется один раз при загрузке; исключение или незавершение за **10 секунд** — состояние `failed`, плагин ничего не добавляет, остальные плагины загружаются. `deactivate` объявлен в типе, веб-хост приложения его не вызывает: веб-часть живёт до перезагрузки страницы.

```ts
import { defineWebPlugin } from "@smart-tools/plugin-sdk/host";

export default defineWebPlugin({
  activate(ctx) {
    ctx.log.info("web half activated");
  },
});
```

<a id="seam-rpc"></a>

### rpc — методы серверной части

<a id="t-rpchandler"></a>

**`RpcHandler`**

```ts
export type RpcHandler = (payload: unknown, ctx: ServerCtx) => Promise<JsonEncodable | void>;
```

<a id="t-jsonencodable"></a>

**`JsonEncodable`**

```ts
export type JsonEncodable =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<JsonEncodable>
  | { readonly [key: string]: JsonEncodable };
```

- отображение «имя метода → обработчик», вызывается из веб-части как `ctx.invoke(method, payload)` или `ctx.query(method, input)`;
- `payload` без значения — ключ отсутствует в сообщении, обработчик получает `undefined`;
- **ответ — только JSON**: `null`, конечное число, boolean, строка, массив и простой объект из них. `NaN`, `Infinity`, `Date`, `Map`, `BigInt`, цикл, дыра в массиве, ключ со значением `undefined` — отказ `invalid-answer` с путём к значению (например `answer.sessions[12].avgTokens`). Обработчик к этому моменту уже выполнился, его побочные эффекты произошли;
- `undefined` в ответе приходит в веб-часть как `null`;
- исключение обработчика — `plugin-failed`; поле `data` брошенной ошибки передаётся в веб-часть дословно ([Ошибки](#errors)).

```ts
import { defineServerPlugin, rpcFailure } from "@smart-tools/plugin-sdk/host";

export default defineServerPlugin({
  rpc: {
    "notes.list": async (_payload, ctx) => [
      ...(await ctx.storage.query<{ id: number; body: string }>("SELECT id, body FROM notes")),
    ],
    "notes.add": async (payload, ctx) => {
      const body = (payload as { body?: unknown } | undefined)?.body;
      if (typeof body !== "string" || body.trim() === "") {
        throw rpcFailure({ kind: "empty-body" }, "a note needs a non-empty body");
      }
      await ctx.storage.exec("INSERT INTO notes(body) VALUES (?)", [body.trim()]);
    },
  },
});
```

<a id="seam-session"></a>

### session — участие в жизненном цикле сессии

<a id="t-sessionseam"></a>

**`SessionSeam`**

```ts
export type SessionSeam = {
  fingerprint?(threadId: string, projectId: string | null, ctx: ServerCtx): Promise<string | null>;
  provision?(projectId: string, targetCwd: string, ctx: ServerCtx): Promise<void>;
};
```

- `fingerprint(threadId, projectId, ctx)` — стабильный отпечаток всего, что плагин добавляет в пару (диалог, проект). Приложение сравнивает его с отпечатком последнего запуска; изменение — сессия провайдера перезапускается на следующем сообщении. `null` — «нечего добавить / не удалось определить», перезапуска не вызывает. `projectId` равен `null` у диалога без проекта. Отпечаток строится по входам (имена, mtime, хэш), а не по содержимому;
- `provision(projectId, targetCwd, ctx)` — перенести принадлежащее плагину в `targetCwd` непосредственно перед **каждым** запуском (например, в git worktree); идемпотентно, случай «ничего не делать» — дешёвый;
- каждый вызов ограничен **5 секундами**; исключение, отказ или превышение времени пишутся в лог и считаются безопасным ответом (`fingerprint` — «ничего не изменилось», `provision` — выполнено). Запуск сессии ничто из этого не останавливает;
- `fingerprint` вызывается раз за ход и ещё раз сразу после запуска (зафиксировать, что загружено); вызовы разных плагинов идут последовательно, их время складывается.

```ts
import { defineServerPlugin } from "@smart-tools/plugin-sdk/host";
import { stat } from "node:fs/promises";
import { join } from "node:path";

export default defineServerPlugin({
  session: {
    fingerprint: async (_threadId, projectId, ctx) => {
      if (projectId === null) return null;
      const info = await stat(join(ctx.paths.dataDir, `${projectId}.json`)).catch(() => null);
      return info === null ? null : String(info.mtimeMs);
    },
    provision: async (projectId, targetCwd, ctx) => {
      ctx.log.info("provision", { projectId, targetCwd });
    },
  },
});
```

<a id="seam-migrations"></a>

### migrations — схема собственной SQLite

<a id="t-migration"></a>

**`Migration`**

```ts
export type Migration = {
  readonly id: string;
  readonly sql: string | ReadonlyArray<string>;
};
```

- применяются к `<stateDir>/plugins/<id>/data.sqlite` один раз, в порядке массива; каждая — в своей транзакции вместе со строкой учёта в `_plugin_migrations` внутри того же файла;
- первая ошибка останавливает применение и переводит **этот** плагин в `failed` с `id` миграции в сообщении;
- `sql` строкой — приложение само делит его на операторы (понимает строки, три вида кавычек идентификаторов, комментарии, тела `CREATE TRIGGER … BEGIN … END`; слово `END` в имени столбца делитель не отличит от конца триггера);
- `sql` массивом — каждый элемент ровно один оператор, выполняется без деления; форма для триггеров. Комментарии допустимы в обеих формах;
- опубликованный `sql` не редактируют — добавляют новый `id`;
- к миграциям применяется та же проверка операторов, что к хранилищу ([storage](#ctx-storage)).

```ts
import { defineServerPlugin } from "@smart-tools/plugin-sdk/host";

export default defineServerPlugin({
  migrations: [
    {
      id: "001-notes",
      sql: "CREATE TABLE notes(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    },
    { id: "002-notes-index", sql: "CREATE INDEX idx_notes_created ON notes(created_at)" },
    {
      id: "003-counter",
      sql: [
        "CREATE TABLE meta(n INTEGER NOT NULL)",
        "INSERT INTO meta(n) VALUES (0)",
        "CREATE TRIGGER bump AFTER INSERT ON notes BEGIN UPDATE meta SET n = n + 1; END",
      ],
    },
  ],
});
```

<a id="seam-server-lifecycle"></a>

### activate / deactivate (сервер)

Порядок запуска серверной части: импорт → проверка формы → открытие хранилища → миграции → `activate`. Каждый шаг ограничен **15 секундами**; исключение или зависание — `failed` у этого плагина, запуск приложения продолжается. `deactivate` выполняется при остановке сервера с тем же бюджетом. Экспорт по умолчанию в виде функции принимается как `activate`. Шов неверной формы отбрасывается. Всё, что хранится в памяти, пропадает вместе с процессом.

```ts
import { defineServerPlugin } from "@smart-tools/plugin-sdk/host";

export default defineServerPlugin({
  activate(ctx) {
    ctx.log.info("activated", { dataDir: ctx.paths.dataDir });
  },
  deactivate(ctx) {
    ctx.log.info("deactivated");
  },
});
```

<a id="webctx"></a>

## 4. Веб-контекст WebCtx

Каждый веб-шов получает `ctx: WebCtx` — простые значения, сигналы и функции, уже привязанные к этому плагину. Аргумента, позволяющего обратиться к другому плагину, нет.

<a id="t-webctx"></a>

**`WebCtx`**

```ts
export type WebCtx = {
  readonly pluginId: string;
  invoke<Result = unknown>(method: string, payload?: unknown): Promise<Result>;
  readonly locale: Signal<PluginLocale>;
  readonly theme: Signal<PluginTheme>;
  readonly connection: Signal<PluginConnection>;
  readonly activeProject: Signal<string | null>;
  readonly projects: Signal<ReadonlyArray<PluginProject>>;
  readonly provider: Signal<string | null>;
  toast(kind: ToastKind, message: string, detail?: string): void;
  closePanel(id: string): void;
  invalidate(seam: InvalidateSeam): void;
  state(name: string): Signal<Json | undefined>;
  query<T = Json>(method: string, input?: Json | (() => Json)): QuerySignal<T>;
  readonly log: PluginLogger;
  assetUrl(rel: string): string;
  pickFolder(options?: PickFolderOptions): Promise<string | null>;
  readonly composer: ComposerContext;
};
```

<a id="ctx-signal"></a>

### Signal и useSignal

<a id="t-signal"></a>

**`Signal`**

```ts
export type Signal<T> = {
  get(): T;
  subscribe(listener: () => void): () => void;
};
```

<a id="t-usesignal"></a>

**`useSignal`**

```ts
export function useSignal<T>(signal: Signal<T>): T {
  return useSyncExternalStore(signal.subscribe, signal.get, signal.get);
}
```

`get()` работает вне React (в `activate`, в фоновом цикле); `subscribe` возвращает функцию отписки, слушатель вызывается без аргументов. `useSignal` из `@smart-tools/plugin-sdk/react` превращает сигнал в перерисовку на общем React приложения.

```tsx
import { useSignal } from "@smart-tools/plugin-sdk/react";
import type { WebCtx } from "@smart-tools/plugin-sdk/host";

export const ThemeBadge = ({ ctx }: { ctx: WebCtx }) => {
  const theme = useSignal(ctx.theme);
  return <span>{theme}</span>;
};
```

<a id="ctx-pluginid"></a>

### pluginId

Идентификатор плагина — имя его папки.

```ts
ctx.log.info(`running as ${ctx.pluginId}`);
```

<a id="ctx-invoke"></a>

### invoke

`invoke<Result>(method, payload?)` вызывает метод, который серверная часть экспортировала в `rpc`. Параметр типа — утверждение, а не проверка. Отказ — всегда `PluginRpcErrorShape` (с `data`, если обработчик её приложил).

- вызов при отсутствии соединения **паркуется** и отправляется, когда соединение готово; без таймеров;
- вызов отправляется **один раз**: разрыв соединения во время вызова — отказ `transport`, повтор не выполняется;
- ожидать отправки одновременно могут не больше 16 вызовов плагина; сверх этого — отказ `transport`.

```ts
import { isPluginRpcError, pluginFailureData } from "@smart-tools/plugin-sdk/host";

try {
  const notes = await ctx.invoke<ReadonlyArray<{ id: number; body: string }>>("notes.list");
  ctx.log.info("notes", { count: notes.length });
} catch (error) {
  if (isPluginRpcError(error)) ctx.log.warn(error.reason, { data: pluginFailureData(error) });
}
```

<a id="ctx-state"></a>

### state

`state(name)` — **текущее значение**, которое серверная часть плагина публикует через `ctx.publish(name, value)`. `undefined` до первой публикации, затем текущее значение сервера во всех вкладках.

- значение применяется, только если оно структурно отличается от текущего: эхо собственного вызова, повтор и повторная отправка после переподключения ничего не перерисовывают;
- на одно имя — один и тот же `Signal`;
- имя: 1–64 символа `A-Z a-z 0-9 . _ -`, первый — буква или цифра; не больше 16 имён на плагин во вкладке. Неверное имя или 17-е имя — сигнал навсегда `undefined` и одна запись о проблеме (`state-name-invalid` / `cap:state-names`), без исключения;
- исключение в слушателе перехватывается, записывается один раз (`state-listener-threw`), остальные слушатели вызываются;
- публикуется сводка (фаза, счётчик, курсор, небольшой список), подробности читаются через `query`.

```tsx
import { useSignal } from "@smart-tools/plugin-sdk/react";

type Summary = { readonly phase: "idle" | "running"; readonly lines: number };

const summary = useSignal(ctx.state("run.summary")) as Summary | undefined;
const running = summary?.phase === "running";
```

<a id="ctx-query"></a>

### query

<a id="t-queryresult"></a>

**`QueryResult`**

```ts
export type QueryResult<T> =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly value: T }
  | { readonly phase: "failed"; readonly error: PluginRpcErrorShape };
```

<a id="t-querysignal"></a>

**`QuerySignal`**

```ts
export type QuerySignal<T> = Signal<QueryResult<T>> & {
  refresh(): Promise<Exclude<QueryResult<T>, { readonly phase: "loading" }>>;
};
```

`query<T>(method, input?)` — чтение собственного метода `rpc`, которое приложение поддерживает актуальным.

- чтение отправляется при первой подписке (если чтение уже в пути — используется оно), **снова при каждом возврате соединения в `ready`** после того, как оно было готово, и при `refresh()`; других повторов нет (ни таймера, ни опроса);
- в пути всегда одно чтение; `refresh()` или переподключение во время чтения стоит ровно одно чтение после него;
- `get()` — один `QueryResult`: `loading` до завершения первого чтения, затем `ready` со значением или `failed` с ошибкой; каждое завершённое чтение заменяет результат;
- слушатели узнают только об **изменении** результата: `ready`, структурно равный текущему `ready`, никого не уведомляет, и `get()` сохраняет прежний объект; переход `failed` → `ready` уведомляет всегда;
- неудачное чтение повторяется только при следующем возврате в `ready` или `refresh()`;
- `refresh()` никогда не отклоняется и разрешается результатом своего раунда;
- `input`-функция вызывается в начале каждого чтения (курсор читается свежим);
- каждый вызов `query` создаёт новый запрос: создавать один раз (в эффекте, модуле, `useMemo`). Запрос живёт, пока есть подписчик; последняя отписка его уничтожает (дальше он ничего не доставляет, `refresh()` всё ещё завершается), следующая подписка читает заново;
- не больше 16 живых запросов на плагин; следующий не живой (нет чтения при подписке и после переподключения, остаётся `loading`), одна запись `cap:queries`; явный `refresh()` на нём читает один раз;
- соединение для повторного чтения плагин **не отслеживает**: это делает приложение.

```tsx
import { useMemo } from "react";
import { useSignal } from "@smart-tools/plugin-sdk/react";

type Note = { readonly id: number; readonly body: string };

const notes = useMemo(() => ctx.query<ReadonlyArray<Note>>("notes.list"), [ctx]);
const result = useSignal(notes);
if (result.phase === "loading") return <p>…</p>;
if (result.phase === "failed") return <p>{result.error.reason}</p>;
return (
  <ul>
    {result.value.map((n) => (
      <li key={n.id}>{n.body}</li>
    ))}
  </ul>
);
```

**Лог после курсора.** Сводка публикуется через `publish`, строки читаются запросом с курсором, а `refresh()` вызывается, пока представление отстаёт. Модуль целиком (берётся копированием, `plugin-auto-coder/src/web/follow.ts`):

<a id="t-followlogoptions"></a>

**`FollowLogOptions`**

```ts
export type FollowLogOptions<Frame> = {
  readonly lines: QuerySignal<Frame>;
  readonly summary: Signal<unknown>;
  readonly behind: () => boolean;
  readonly show: (result: QueryResult<Frame>) => void;
};
```

<a id="t-followlog"></a>

**`followLog`**

```ts
export const followLog = <Frame>({
  lines,
  summary,
  behind,
  show,
}: FollowLogOptions<Frame>): (() => void) => {
  const catchUp = (): void => {
    if (behind()) void lines.refresh();
  };
  const stopLines = lines.subscribe(() => {
    const result = lines.get();
    show(result);
    if (result.phase === "ready") catchUp();
  });
  const stopSummary = summary.subscribe(catchUp);
  return () => {
    stopLines();
    stopSummary();
  };
};
```

```tsx
useEffect(
  () =>
    followLog({
      lines: ctx.query<Frame>("run.output", () => ({ projectId, since: store.cursor })),
      summary: ctx.state("run.output"),
      behind: () => behind(summaryOf(projectId), store.cursor),
      show: (result) => store.show(result),
    }),
  [projectId],
);
```

<a id="ctx-connection"></a>

### connection

<a id="t-pluginconnection"></a>

**`PluginConnection`**

```ts
export type PluginConnection = "connecting" | "ready" | "lost";
```

Состояние связи с сервером, читается из того же источника, по которому `invoke` решает об отправке. Для повторного чтения данных его не отслеживают — для этого `query`; сигнал нужен интерфейсу.

```tsx
const connection = useSignal(ctx.connection);
return <button disabled={connection !== "ready"}>Start</button>;
```

<a id="ctx-locale"></a>

### locale

<a id="t-pluginlocale"></a>

**`PluginLocale`**

```ts
export type PluginLocale = "en" | "ru";
```

Язык приложения. Постоянен в течение жизни документа: смена языка перезагружает страницу. Строки плагин переводит сам; для этого есть `@smart-tools/plugin-sdk/locale`.

<a id="t-locale"></a>

**`Locale`**

```ts
export type Locale = "en" | "ru";
```

<a id="t-pluralru"></a>

**`PluralRu`**

```ts
export type PluralRu = readonly [one: string, few: string, many: string];
```

<a id="t-pluginlocaleapi"></a>

**`PluginLocaleApi`**

```ts
export interface PluginLocaleApi {
  readonly L: (en: string, ru: string) => string;
  readonly LT: (en: string, ru: string, exprs: readonly unknown[]) => string;
  readonly LN: (count: number, en: readonly [string, string], ru: PluralRu) => string;
  readonly currentLocale: () => Locale;
  readonly currentLocaleTag: () => string;
  readonly configure: (getLocale: () => Locale) => void;
  readonly reset: () => void;
}
```

<a id="t-createlocale"></a>

**`createLocale`**

```ts
export const createLocale = (): PluginLocaleApi => { … }
```

<a id="t-localecarryingctx"></a>

**`LocaleCarryingCtx`**

```ts
export interface LocaleCarryingCtx {
  readonly pluginId: string;
  readonly locale: { get(): Locale };
}
```

<a id="t-pluginruntime"></a>

**`PluginRuntime`**

```ts
export interface PluginRuntime<Ctx extends LocaleCarryingCtx> extends PluginLocaleApi {
  remember(ctx: Ctx): Ctx;
  ctx(): Ctx;
  reset(): void;
}
```

<a id="t-createpluginruntime"></a>

**`createPluginRuntime`**

```ts
export const createPluginRuntime = <Ctx extends LocaleCarryingCtx>(
  pluginId: string,
  locale: PluginLocaleApi = createLocale(),
): PluginRuntime<Ctx> => { … }
```

- `createLocale()` — фабрика: у каждого экземпляра свой резолвер; язык по умолчанию `"ru"`; `configure` хранит функцию-геттер, а не значение; `reset()` возвращает умолчание;
- `LT` подставляет `{0}`, `{1}`, … по индексу; `LN` выбирает форму числительного через `Intl.PluralRules`;
- `createPluginRuntime(pluginId, locale)` — держатель контекста и языка: `remember(ctx)` вызывается в каждом шве и в `activate`, `ctx()` возвращает контекст для смонтированного компонента (бросает `"<id>: no plugin ctx yet — a seam has not run"`, если ни один шов не выполнялся). `locale` — собственный экземпляр плагина, через который рендерятся его строки.

```ts
// src/localization.ts
import { createLocale } from "@smart-tools/plugin-sdk/locale";

export const locale = createLocale();
export const { L, LT, LN } = locale;

// src/web/runtime.ts
import { createPluginRuntime } from "@smart-tools/plugin-sdk/locale";
import type { WebCtx } from "@smart-tools/plugin-sdk/host";
import { locale } from "../localization.ts";

export const { remember: rememberCtx, ctx: notesCtx } = createPluginRuntime<WebCtx>(
  "notes",
  locale,
);

// в компоненте
const title = L("Notes", "Заметки");
const count = LN(5, ["note", "notes"], ["заметка", "заметки", "заметок"]);
```

<a id="ctx-theme"></a>

### theme

<a id="t-plugintheme"></a>

**`PluginTheme`**

```ts
export type PluginTheme = "light" | "dark";
```

Итоговая тема оформления приложения.

```tsx
const theme = useSignal(ctx.theme);
const chartStroke = theme === "dark" ? "#9ab" : "#345";
```

<a id="ctx-projects"></a>

### projects

<a id="t-pluginproject"></a>

**`PluginProject`**

```ts
export type PluginProject = {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
};
```

Все существующие проекты в порядке приложения; меняется, когда пользователь добавляет проект. `id` — идентификатор проекта приложения (тот же, что у диалога), `name` — заданное пользователем название, `cwd` — корень рабочей области.

```tsx
const projects = useSignal(ctx.projects);
return (
  <select>
    {projects.map((p) => (
      <option key={p.id} value={p.id}>
        {p.name}
      </option>
    ))}
  </select>
);
```

<a id="ctx-activeproject"></a>

### activeProject

Проект, который пользователь видит сейчас (проект открытого диалога или черновика), или `null` на поверхности без диалога. `null` — настоящий ответ «только глобальное», а не «неизвестно».

```tsx
const projectId = useSignal(ctx.activeProject);
const scope = projectId === null ? "global" : projectId;
```

<a id="ctx-provider"></a>

### provider

Экземпляр провайдера, которому композер отправит сообщение в текущем диалоге, или `null` без диалога. Строка — непрозрачный идентификатор экземпляра провайдера приложения.

```tsx
const provider = useSignal(ctx.provider);
if (provider === null) return null;
```

<a id="ctx-toast"></a>

### toast

<a id="t-toastkind"></a>

**`ToastKind`**

```ts
export type ToastKind = "success" | "error" | "info";
```

`toast(kind, message, detail?)` — тост плагина в стеке приложения, предназначен пользователю. Значения не приводятся: `kind` — один из `ToastKind`, `message` — строка, `detail` — строка или отсутствует; любой длины, в том числе многострочные. Неверный вызов отбрасывается с одной записью о проблеме. Не больше 50 тостов на плагин за загрузку страницы.

```ts
ctx.toast("success", "Note saved");
ctx.toast("error", "Could not save the note", "The server answered: disk full");
```

<a id="ctx-invalidate"></a>

### invalidate

<a id="t-invalidateseam"></a>

**`InvalidateSeam`**

```ts
export type InvalidateSeam = "composer" | "panels" | "pages" | "background";
```

Сообщает приложению, что вклад плагина в шов изменился, и приложение перевызывает этот шов **только для этого плагина**. Швы вызываются тогда, когда поверхность нужна приложению, поэтому после изменения собственных данных плагин вызывает `invalidate`. Несколько вызовов за один тик стоят один пересчёт. Из самого шва, который называется, не вызывается. Имя вне четырёх отбрасывается с одной записью о проблеме.

```ts
await refreshNotesStore();
ctx.invalidate("composer");
```

<a id="ctx-closepanel"></a>

### closePanel

Закрывает одну из панелей **этого** плагина по `id`, который ей дал шов `panels`, в каком бы слоте она ни была смонтирована. Если открыта не она (в том числе панель другого плагина) — ничего не делает.

```tsx
<button onClick={() => ctx.closePanel("notes")}>Close</button>
```

<a id="ctx-pickfolder"></a>

### pickFolder

<a id="t-pickfolderoptions"></a>

**`PickFolderOptions`**

```ts
export type PickFolderOptions = {
  readonly start?: string;
};
```

Открывает модальный выбор папки приложения и разрешается **абсолютным путём** или `null`, если пользователь ничего не выбрал (Esc, клик по фону, закрытие по любой причине, экран без выбора папок).

- `start` — подсказка, где открыть; нечитаемый путь (или длиннее 512 символов) открывает домашнюю папку, без ошибки;
- одновременно открыт один выбор: вызов другого плагина ждёт своей очереди;
- у плагина один ожидающий вызов: второй вызов, пока первый без ответа, сразу разрешается `null` с одной записью о проблеме — кнопку блокируют на время выбора;
- вызов, сделанный, пока открыта палитра команд, ждёт её закрытия.

```tsx
const [picking, setPicking] = useState(false);
const choose = async () => {
  setPicking(true);
  try {
    const folder = await ctx.pickFolder({ start: "~/projects" });
    if (folder !== null) await ctx.invoke("folder.set", { folder });
  } finally {
    setPicking(false);
  }
};
return (
  <button disabled={picking} onClick={choose}>
    Choose folder
  </button>
);
```

<a id="ctx-composer"></a>

### composer

<a id="t-composercontext"></a>

**`ComposerContext`**

```ts
export type ComposerContext = {
  readonly target: Signal<string | null>;
  attach(target: string, item: ComposerAttachment): void;
  detach(target: string, id: string): void;
  attached(target: string): ReadonlyArray<string> | null;
  subscribe(listener: () => void): () => void;
};
```

<a id="t-composerattachment"></a>

**`ComposerAttachment`**

```ts
export type ComposerAttachment = {
  readonly id: string;
  readonly group: string;
  readonly title: string;
  readonly name: string;
  readonly label: string;
  readonly text: string;
  readonly body: string;
  readonly language?: string;
};
```

Прикрепляет к черновику композера **карточку контекста**: чип на черновике пользователя, который отправляется вместе с сообщением (содержимое `body` вкладывается в сообщение). Это не `composer.items`: тот шов добавляет строки меню, вставляющие текст.

- `target` — непрозрачный токен композера, на котором пользователь сейчас, или `null`; каждый вызов называет свой токен, поэтому карточку можно открепить и после перехода в другой диалог;
- `attach` с тем же `id` заменяет карточку; неверная карточка отбрасывается с одной записью о проблеме; `target` без черновика — ничего не происходит;
- `attached(target)` — идентификаторы карточек плагина на этом композере, или `null`, если у композера **нет черновика вовсе** (`null` ≠ `[]`);
- `subscribe` — любой черновик изменился; слушатель вызывается без аргументов;
- `id` и `group` — непустые строки (ключи, не отображаются); `title`, `label`, `text` — строки (`text` рисуется многострочным); `name` — НЕПУСТАЯ строка (это `filePath` отправленного `<review_comment>`, без него карточку не прочитать обратно); `body` — строка, отправляется целиком (длину сообщения ограничивает само приложение при отправке); `language` — отсутствует или строка без пробельных символов (иначе ломается заголовок блока кода); идентификаторы получают префикс `plugin:<pluginId>:`, поэтому плагины не пересекаются.

```tsx
const target = useSignal(ctx.composer.target);
if (target !== null) {
  ctx.composer.attach(target, {
    id: card.id,
    group: card.id,
    title: `Card · ${card.name}`,
    name: `cards/${card.name}`,
    label: "3 nodes",
    text: card.name,
    body: card.json,
    language: "json",
  });
}
```

<a id="ctx-log"></a>

### log

<a id="t-pluginlogger"></a>

**`PluginLogger`**

```ts
export type PluginLogger = {
  info(message: string, data?: Readonly<Record<string, unknown>>): void;
  warn(message: string, data?: Readonly<Record<string, unknown>>): void;
  error(message: string, data?: Readonly<Record<string, unknown>>): void;
};
```

В веб-части пишет в консоль браузера (`console.info` / `.warn` / `.error`) с префиксом `[plugin:<id>]`.

```ts
ctx.log.warn("snapshot is stale", { ageMs: 12_000 });
```

<a id="ctx-asseturl"></a>

### assetUrl

`assetUrl(rel)` возвращает `/plugins/<id>/<rel>`. **Бросает исключение** на не-строку, пустую строку, ведущий `/`, NUL или сегмент `.` / `..`.

```tsx
<img src={ctx.assetUrl("assets/logo.svg")} alt="" />
```

<a id="serverctx"></a>

## 5. Серверный контекст ServerCtx

Каждый серверный шов получает `ctx: ServerCtx`. Всё на промисах, без effect.

<a id="t-serverctx"></a>

**`ServerCtx`**

```ts
export type ServerCtx = {
  readonly pluginId: string;
  readonly storage: PluginStorage;
  readonly paths: PluginPaths;
  readonly projects: PluginProjects;
  readonly log: PluginLogger;
  locale(): PluginLocale;
  publish(name: string, value: Exclude<JsonEncodable, undefined>): void;
};
```

<a id="ctx-storage"></a>

### storage

<a id="t-pluginstorage"></a>

**`PluginStorage`**

```ts
export type PluginStorage = {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<ReadonlyArray<Row>>;
  exec(sql: string, params?: ReadonlyArray<unknown>): Promise<void>;
};
```

Собственная SQLite плагина `<stateDir>/plugins/<id>/data.sqlite`; открывается при запуске до `activate` (даже без миграций), в режиме WAL, с `foreign_keys = ON` и `busy_timeout = 5000`. Данные переживают удаление папки плагина.

- `query(sql, params?)` — **ровно один оператор**;
- `exec(sql, params?)` — несколько операторов, **только без параметров**; с параметрами — один оператор;
- отклоняется (в обработчиках и в миграциях): `ATTACH` / `DETACH`; `PRAGMA`, кроме `user_version`, `table_info`, `foreign_keys` и чтения `journal_mode`; любой идентификатор `pragma_*`, в том числе строковый литерал на месте таблицы; запись в таблицу `sqlite_*` (кроме `sqlite_sequence`). Отказ приходит в веб-часть как `plugin-failed` с правилом в `detail`.

```ts
const rows = await ctx.storage.query<{ n: number }>(
  "SELECT count(*) AS n FROM notes WHERE body LIKE ?",
  ["%todo%"],
);
await ctx.storage.exec("DELETE FROM notes WHERE id = ?", [42]);
await ctx.storage.exec("CREATE TABLE IF NOT EXISTS a(x); CREATE TABLE IF NOT EXISTS b(y);");
```

<a id="ctx-projects-server"></a>

### projects

<a id="t-pluginprojects"></a>

**`PluginProjects`**

```ts
export type PluginProjects = {
  list(): Promise<ReadonlyArray<PluginProject>>;
};
```

`list()` — все существующие и не удалённые проекты в порядке приложения, `{ id, name, cwd }`. Ошибка чтения даёт `[]`, а не отказ.

```ts
const projects = await ctx.projects.list();
const byId = new Map(projects.map((p) => [p.id, p]));
```

<a id="ctx-paths"></a>

### paths

<a id="t-pluginpaths"></a>

**`PluginPaths`**

```ts
export type PluginPaths = {
  readonly dataDir: string;
  readonly cliConfigDir: string | null;
};
```

`dataDir` — папка с `data.sqlite` плагина, переживает удаление плагина. `cliConfigDir` — рабочая база CLI или `null`, если CLI не обнаружен.

```ts
import { join } from "node:path";

const cacheFile = join(ctx.paths.dataDir, "cache.json");
const cliDir = ctx.paths.cliConfigDir ?? null;
```

<a id="ctx-log-server"></a>

### log

Пишет в структурированный лог сервера с идентификатором плагина. `console.log` на сервере минует фильтр уровней и файл лога.

```ts
ctx.log.error("sync failed", { projectId, attempt: 1 });
```

<a id="ctx-locale-server"></a>

### locale

`locale()` — язык приложения **в момент вызова** (пользователь может сменить его, пока сервер работает). Строки, которые читает пользователь, лучше отдавать кодами (`{ code, params? }`) и переводить в веб-части; `locale()` — для текста, который формирует зависимость до того, как его видит плагин.

```ts
const title = ctx.locale() === "en" ? "Report" : "Отчёт";
```

<a id="ctx-publish"></a>

### publish

`publish(name, value)` делает `value` **текущим значением** `name` для всех вкладок (веб-часть читает его через `ctx.state(name)`).

- вызывается когда угодно и сколько угодно: приложение хранит последнее значение и пересылает только структурно отличающееся; вкладка, открытая позже, получает текущее значение;
- синхронный, **не бросает исключений и не ждёт**;
- значение — простой JSON (проверка как у ответа `rpc`), не больше 16 МиБ JSON-текста;
- имя — как у `state`; не больше 16 различных имён на плагин за процесс;
- отказ (неверное имя, 17-е имя, не JSON, превышение размера) отбрасывает публикацию, прежнее значение остаётся, одна строка в логе на причину;
- ограничения частоты нет: на имя и вкладку в пути не больше одного значения.

```ts
await ctx.storage.exec("INSERT INTO notes(body) VALUES (?)", [body]);
const [row] = await ctx.storage.query<{ n: number }>("SELECT count(*) AS n FROM notes");
ctx.publish("notes.count", { count: row?.n ?? 0 });
```

<a id="ctx-pluginid-server"></a>

### pluginId

Идентификатор плагина — имя его папки.

```ts
ctx.log.info("ready", { plugin: ctx.pluginId });
```

<a id="errors"></a>

## 6. Ошибки

Любой отказ `ctx.invoke` (и `failed` у `ctx.query`) — объект формы `PluginRpcErrorShape`. Сужение — `isPluginRpcError`, затем `switch` по `reason` с веткой `default`: более новое приложение может ответить причиной, которой нет в этой версии SDK.

<a id="t-plugin-rpc-error-reasons"></a>

**`PLUGIN_RPC_ERROR_REASONS`**

```ts
export const PLUGIN_RPC_ERROR_REASONS = [
  "unknown-plugin",
  "unknown-method",
  "plugin-failed",
  "plugin-disabled",
  "unauthorized",
  "invalid-payload",
  "invalid-answer",
  "transport",
] as const;

export type PluginRpcErrorReason = (typeof PLUGIN_RPC_ERROR_REASONS)[number];
```

<a id="t-pluginrpcerrorshape"></a>

**`PluginRpcErrorShape`**

```ts
export type PluginRpcErrorShape = {
  readonly _tag: "PluginRpcError";
  readonly reason: PluginRpcErrorReason;
  readonly detail?: string;
  readonly data?: Json;
};
```

<a id="t-ispluginrpcerror"></a>

**`isPluginRpcError`**

```ts
export function isPluginRpcError(u: unknown): u is PluginRpcErrorShape { … }
```

<a id="t-rpcfailure"></a>

**`rpcFailure`**

```ts
export const rpcFailure = (data: JsonEncodable, message: string): Error =>
  Object.assign(new Error(message), { data });
```

<a id="t-pluginfailuredata"></a>

**`pluginFailureData`**

```ts
export const pluginFailureData = (error: unknown): Json | null => { … }
```

<a id="t-json"></a>

**`Json`**

```ts
export type Json =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };
```

Серверная сторона того же контракта (схема протокола в `@smart-tools/plugin-sdk/contracts`):

<a id="t-pluginrpcerror"></a>

**`PluginRpcError`**

```ts
export class PluginRpcError extends Schema.TaggedErrorClass<PluginRpcError>()("PluginRpcError", {
  reason: PluginRpcErrorReason,
  detail: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
}) {
  override get message(): string {
    return `Plugin RPC error (${this.reason})${this.detail === undefined ? "" : `: ${this.detail}`}`;
  }
}
```

| `reason`          | что произошло                                                                               | кто породил | что делать                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `unknown-plugin`  | плагин с таким id не загружен                                                               | приложение  | до плагина не доходит                                                               |
| `unknown-method`  | у плагина нет обработчика с таким именем (в том числе у плагина без серверной части)        | приложение  | ошибка в плагине                                                                    |
| `plugin-failed`   | обработчик плагина бросил исключение или отклонился; `data` — то, что он приложил           | плагин      | своё сообщение по `data`                                                            |
| `plugin-disabled` | папка есть, но плагин пропущен или выключен                                                 | приложение  | плагин выключен или не загрузился                                                   |
| `unauthorized`    | у сессии нет нужных прав                                                                    | приложение  | плагин исправить не может                                                           |
| `invalid-payload` | аргумент не удалось закодировать для передачи                                               | приложение  | ошибка в плагине                                                                    |
| `invalid-answer`  | обработчик выполнился и вернул не JSON; `detail` содержит путь                              | приложение  | ошибка в плагине; побочные эффекты произошли                                        |
| `transport`       | вызов не дошёл до сервера, соединение оборвалось во время вызова или ожидает уже 16 вызовов | приложение  | «нет связи»; `query` перечитает сам, команду повторяют только если она идемпотентна |

**`data`.** Если обработчик бросает `Error` с полем `data`, приложение передаёт `data` в `PluginRpcError.data` дословно. `data` должно быть JSON, иначе поле отбрасывается (`reason` и `detail` остаются). `rpcFailure(data, message)` создаёт такую ошибку; `message` — для лога оператора. `pluginFailureData(error)` возвращает приложенный объект или `null` (нет данных обработчика или `data` — примитив).

```ts
// сервер
import { rpcFailure } from "@smart-tools/plugin-sdk/host";

type NotesFailure =
  | { readonly kind: "body-too-long"; readonly max: number }
  | { readonly kind: "empty-body" };
export const notesFailure = (data: NotesFailure, message: string): Error =>
  rpcFailure(data, message);

// в обработчике
throw notesFailure({ kind: "body-too-long", max: 2000 }, "note body too long");
```

```ts
// веб
import { isPluginRpcError, pluginFailureData } from "@smart-tools/plugin-sdk/host";

const describe = (error: unknown): string => {
  const kind = (pluginFailureData(error) as { readonly kind?: unknown } | null)?.kind;
  if (kind === "body-too-long") return "Слишком длинная заметка";
  if (!isPluginRpcError(error)) return "Неизвестная ошибка";
  switch (error.reason) {
    case "transport":
      return "Нет связи с сервером";
    case "plugin-disabled":
      return "Плагин выключен";
    default:
      return `Ошибка: ${error.reason}`;
  }
};
```

<a id="limits"></a>

## 7. Лимиты

Правило одно: вызов шва добавляет не больше N элементов, лишние **отбрасываются**, плагин получает одну запись о проблеме. Исключений нет.

| константа                             | значение                              | к чему относится                                                                                                            |
| ------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `MAX_PAGES_PER_PLUGIN`                | 8                                     | страниц за один вызов `pages`                                                                                               |
| `MAX_PANELS_PER_PLUGIN`               | 4                                     | панелей за один вызов `panels`                                                                                              |
| `MAX_COMPOSER_ROWS_PER_PLUGIN`        | 100                                   | строк плагина, которые меню рисует на один запрос; остальные действительные строки `/` остаются в списке разрешённых команд |
| `MAX_BACKGROUND_PER_PLUGIN`           | 2                                     | фоновых компонентов                                                                                                         |
| `MAX_PARKED_INVOKES_PER_PLUGIN`       | 16                                    | вызовов `invoke`, ожидающих соединения; сверх — отказ `transport`                                                           |
| `MAX_DESCRIPTION_LENGTH`              | 1000                                  | `Panel.description`, `ComposerRow.description` (усекается)                                                                  |
| `MAX_PLUGIN_TOASTS`                   | 50                                    | тостов на плагин за загрузку страницы                                                                                       |
| `MIN_PANEL_WIDTH` / `MAX_PANEL_WIDTH` | 320 / 960                             | `Panel.width` при `mount: "panel"`                                                                                          |
| `PLUGIN_SLUG_PATTERN`                 | `/^[a-z0-9][a-z0-9-]{0,63}$/`         | `Page.id`, `Panel.id`                                                                                                       |
| ожидающий `pickFolder`                | 1                                     | на плагин; второй вызов сразу `null`                                                                                        |
| `pickFolder` `start`                  | 512                                   | символов; длиннее — открывается домашняя папка                                                                              |
| `MAX_MANIFEST_TEXT_LENGTH`            | 200                                   | `name` / `description` манифеста, усекается                                                                                 |
| `STATE_NAME_PATTERN`                  | `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` | имена `publish` / `state`                                                                                                   |
| `MAX_STATE_NAMES_PER_PLUGIN`          | 16                                    | различных имён `publish` на плагин за процесс; имён `state` на плагин во вкладке                                            |
| `MAX_STATE_VALUE_BYTES`               | 16 777 216                            | байт UTF-8 JSON-текста одного опубликованного значения                                                                      |
| `MAX_ACTIVE_QUERIES_PER_PLUGIN`       | 16                                    | живых `ctx.query` на плагин                                                                                                 |
| `MAX_SHARED_PACKAGES`                 | 10                                    | размер списка общих модулей                                                                                                 |

Константы state- и query-механизмов, как они объявлены в `@smart-tools/plugin-sdk/state`:

<a id="t-state-name-pattern"></a>

**`STATE_NAME_PATTERN`**

```ts
export const STATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
```

<a id="t-max-state-names-per-plugin"></a>

**`MAX_STATE_NAMES_PER_PLUGIN`**

```ts
export const MAX_STATE_NAMES_PER_PLUGIN = 16;
```

<a id="t-max-state-value-bytes"></a>

**`MAX_STATE_VALUE_BYTES`**

```ts
export const MAX_STATE_VALUE_BYTES = 16_777_216;
```

<a id="t-max-active-queries-per-plugin"></a>

**`MAX_ACTIVE_QUERIES_PER_PLUGIN`**

```ts
export const MAX_ACTIVE_QUERIES_PER_PLUGIN = 16;
```

**Бюджеты времени** — полный список; других таймеров нет, плагин тоже не использует таймеры для опроса.

| бюджет                                                                       | значение | что при превышении              |
| ---------------------------------------------------------------------------- | -------- | ------------------------------- |
| импорт веб-части и `activate`, на плагин                                     | 10 с     | `failed`                        |
| поверхность в `<Suspense>` без результата                                    | 10 с     | запись «never finished loading» |
| шаг серверного жизненного цикла (импорт, миграции, `activate`, `deactivate`) | 15 с     | `failed`                        |
| один вызов шва `session`                                                     | 5 с      | безопасный ответ                |

<a id="shared"></a>

## 8. Общие модули

Веб-часть импортирует по имени только спецификаторы из списка ниже. Приложение публикует их через `<script type="importmap">`, поэтому плагин получает **тот же экземпляр модуля**, что у приложения. Совпадение — точное, по строке. Сборка записывает в `plugin.json` поле `shared` (установленные версии тех спецификаторов, которые веб-часть оставила внешними); приложение сравнивает мажорные версии и пропускает плагин при расхождении.

<a id="t-sharedpackage"></a>

**`SharedPackage`**

```ts
export type SharedPackage = {
  readonly specifier: string;
  readonly major: string;
};
```

<a id="t-shared-packages"></a>

**`SHARED_PACKAGES`**

```ts
export const SHARED_PACKAGES: ReadonlyArray<SharedPackage> = [
  { specifier: "react", major: "19" },
  { specifier: "react/jsx-runtime", major: "19" },
  { specifier: "react-dom", major: "19" },
  { specifier: "react-dom/client", major: "19" },
  { specifier: "effect", major: "4" },
  { specifier: "zustand", major: "5" },
  { specifier: "@base-ui/react", major: "1" },
  { specifier: "@pierre/diffs", major: "1" },
  { specifier: "effect/unstable/reactivity", major: "4" },
  { specifier: "effect/unstable/rpc", major: "4" },
];
```

<a id="t-max-shared-packages"></a>

**`MAX_SHARED_PACKAGES`**

```ts
export const MAX_SHARED_PACKAGES = 10;
```

<a id="t-issharedspecifier"></a>

**`isSharedSpecifier`**

```ts
export const isSharedSpecifier = (specifier: string): boolean => SHARED_SPECIFIERS.has(specifier);
```

<a id="t-sharedpackagemajor"></a>

**`sharedPackageMajor`**

```ts
export const sharedPackageMajor = (specifier: string): string | undefined =>
  SHARED_PACKAGES.find((p) => p.specifier === specifier)?.major;
```

<a id="t-majorof"></a>

**`majorOf`**

```ts
export const majorOf = (version: string): string | null => { … }
```

| спецификатор                 | мажорная версия |
| ---------------------------- | --------------- |
| `react`                      | 19              |
| `react/jsx-runtime`          | 19              |
| `react-dom`                  | 19              |
| `react-dom/client`           | 19              |
| `effect`                     | 4               |
| `zustand`                    | 5               |
| `@base-ui/react`             | 1               |
| `@pierre/diffs`              | 1               |
| `effect/unstable/reactivity` | 4               |
| `effect/unstable/rpc`        | 4               |

- `effect/<Module>` (например `effect/Option`) сборка сводит к корневому `effect`; `effect/unstable/<sub>/<Module>` — к `effect/unstable/<sub>`, если этот подпуть в списке; `@base-ui/react/<sub>` — к `@base-ui/react`. Второй копии модуля в бандле не появляется;
- `lucide-react`, `recharts`, UI-киты и прочие `effect/unstable/*` вбандливаются в плагин;
- серверная часть общих модулей не получает: у Node нет import map.

```ts
import { useState } from "react";
import * as Option from "effect/Option"; // сводится к общему "effect"
import { Dialog } from "@base-ui/react/dialog"; // сводится к общему "@base-ui/react"
import { create } from "zustand";
import { Puzzle } from "lucide-react"; // вбандливается
```

<a id="css"></a>

## 9. CSS-скоупинг

Таблица стилей плагина — `<link>` в документе приложения. Сборка вкладывает каждое правило в `[data-plugin-root="<id>"]` (нативная вложенность CSS), а приложение монтирует каждую поверхность плагина внутрь элемента с этим атрибутом.

<a id="t-scopepluginstylesheet"></a>

**`scopePluginStylesheet`**

```ts
export function scopePluginStylesheet(css: string, pluginId: string): string { … }
```

- правила плагина не достают до DOM приложения, а внутри поддерева плагина выигрывают за счёт дополнительного атрибута;
- на верхнем уровне остаются правила `:root` / `html` / `body` / `:host`, а также `@keyframes`, `@property`, `@font-face`;
- внутрь `@media`, `@supports`, `@container`, `@layer`, `@scope`, `@starting-style` скоупинг проходит;
- подряд идущие правила получают одну обёртку, порядок каскада сохраняется; предок-селектор (`.dark .foo`) продолжает работать;
- «голый» спецификатор в `@import` / `url()` итоговой таблицы — ошибка сборки;
- **портал** монтируется внутрь корня плагина, иначе стили к нему не применяются;
- цвета берутся из токенов приложения (`var(--color-…)`), чтобы следовать теме.

```css
/* src/web/styles.css */
.notes-list {
  display: grid;
  gap: 8px;
  color: var(--color-foreground);
}
@media (min-width: 40rem) {
  .notes-list {
    grid-template-columns: 1fr 1fr;
  }
}
```

```css
/* dist/web/styles.css */
[data-plugin-root="notes"] {
  .notes-list {
    display: grid;
    gap: 8px;
    color: var(--color-foreground);
  }
}
@media (min-width: 40rem) {
  [data-plugin-root="notes"] {
    .notes-list {
      grid-template-columns: 1fr 1fr;
    }
  }
}
```

Tailwind-утилиты подключаются шагом сборки `styles: { tailwind: { sources: ["dist/web"] } }`: компиляция против `@theme` приложения, **без preflight**, затем тот же скоупинг ([Сборка](#build)).

<a id="build"></a>

## 10. Сборка

```ts
// tsdown.config.ts
import { pluginBuildConfig } from "@smart-tools/plugin-sdk/build";

export default pluginBuildConfig({
  root: import.meta.dirname,
  server: "src/server/index.ts",
  web: "src/web/index.tsx",
  styles: "src/web/styles.css",
  manifest: "src/plugin.json",
});
```

<a id="t-pluginbuildconfig"></a>

**`pluginBuildConfig`**

```ts
export function pluginBuildConfig(options: PluginBuildOptions): ReadonlyArray<PluginTsdownConfig> { … }
```

<a id="t-pluginbuildoptions"></a>

**`PluginBuildOptions`**

```ts
export type PluginBuildOptions = {
  readonly root: string;
  readonly server?: string | false;
  readonly web?: string | false;
  readonly styles?: PluginStyles;
  readonly manifest?: string;
  readonly outDir?: string;
};
```

<a id="t-pluginstyles"></a>

**`PluginStyles`**

```ts
export type PluginStyles = string | false | { readonly tailwind: PluginTailwindStyles };
```

<a id="t-plugintailwindstyles"></a>

**`PluginTailwindStyles`**

```ts
export type PluginTailwindStyles = {
  readonly input?: string;
  readonly sources: ReadonlyArray<string>;
  readonly theme?: string;
};
```

<a id="t-plugintsdownconfig"></a>

**`PluginTsdownConfig`**

```ts
export type PluginTsdownConfig = {
  readonly name: string;
  readonly cwd: string;
  readonly entry: Readonly<Record<string, string>>;
  readonly outDir: string;
  readonly format: "esm";
  readonly platform: "node" | "browser";
  readonly fixedExtension: true;
  readonly outputOptions?: Readonly<Record<string, unknown>>;
  readonly external: (id: string) => boolean;
  readonly noExternal: (id: string) => boolean;
  readonly inlineOnly: false;
  readonly minify: boolean;
  readonly sourcemap: false;
  readonly dts: false;
  readonly clean: boolean;
  readonly inputOptions: Readonly<Record<string, unknown>>;
  readonly plugins: Array<Record<string, unknown>>;
  readonly hooks: { readonly "build:done": () => void | Promise<void> };
};
```

- значения по умолчанию: `server` — `src/server/index.ts`, `web` — `src/web/index.tsx`, `styles` — `src/web/styles.css`, `manifest` — `src/plugin.json`, `outDir` — `dist`; отсутствующий файл по умолчанию пропускается, явно указанный отсутствующий — ошибка; `false` отключает часть; хотя бы одна из частей обязательна;
- **`dist/` и есть папка плагина**: `dist/plugin.json`, `dist/server/index.mjs`, `dist/web/index.mjs`, `dist/web/styles.css`;
- сборка копирует манифест, проставляет `shared`, скоупит таблицу стилей, проверяет, что пути манифеста существуют в `dist/`, и проверяет граф модулей (`assertPluginBundle`);
- серверная часть собирается **в один файл** (без разделения кода);
- импорт, который сборщик не может разрешить, — ошибка сборки;
- обе части минифицируются, без sourcemap и `.d.ts`.

| часть  | остаётся внешним    | всё остальное                                                              |
| ------ | ------------------- | -------------------------------------------------------------------------- |
| веб    | только общие модули | вбандливается                                                              |
| сервер | только `node:*`     | вбандливается; модуль `react` / `react-dom` / `scheduler` в графе — ошибка |

<a id="t-assertpluginbundle"></a>

**`assertPluginBundle`**

```ts
export function assertPluginBundle(graph: PluginBundleGraph): void { … }
```

<a id="t-pluginbundlegraph"></a>

**`PluginBundleGraph`**

```ts
export type PluginBundleGraph = {
  readonly half: "web" | "server";
  readonly chunks: ReadonlyArray<PluginBundleChunk>;
};
```

<a id="t-pluginbundlechunk"></a>

**`PluginBundleChunk`**

```ts
export type PluginBundleChunk = {
  readonly fileName: string;
  readonly imports: ReadonlyArray<string>;
  readonly dynamicImports?: ReadonlyArray<string>;
  readonly moduleIds: ReadonlyArray<string>;
};
```

<a id="t-finalizepluginbundle"></a>

**`finalizePluginBundle`**

```ts
export function finalizePluginBundle(
  options: PluginBuildOptions,
  sharedExternals: ReadonlySet<string> = new Set(),
): void { … }
```

**Пресеты TypeScript.** Пресет не наследует базовый `tsconfig` репозитория; плагин наследует оба, базовый первым.

| пресет                                                     | для чего                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `@smart-tools/plugin-sdk/tsconfig/plugin.web.json`         | веб-часть: `moduleResolution: Bundler`, `jsx: react-jsx`, DOM, без ambient `@types` |
| `@smart-tools/plugin-sdk/tsconfig/plugin.server.json`      | серверная часть: `lib: ESNext`, `types: []` (без глобалов Node)                     |
| `@smart-tools/plugin-sdk/tsconfig/plugin.server.node.json` | серверная часть, импортирующая встроенные модули Node: `types: ["node"]`            |
| `@smart-tools/plugin-sdk/tsconfig/plugin.test.json`        | тесты: и `node`, и DOM                                                              |

```json
{
  "extends": ["./tsconfig.base.json", "@smart-tools/plugin-sdk/tsconfig/plugin.web.json"],
  "include": ["src/web", "src/localization.ts"]
}
```

<a id="testing"></a>

## 11. Тестирование

`@smart-tools/plugin-sdk/testing` — фейковые контексты, типизированные как настоящие: изменение формы шва ломает тесты плагина на этапе компиляции. Модуль нейтрален: работает в Node и в jsdom.

<a id="t-fakesignal"></a>

**`FakeSignal`**

```ts
export type FakeSignal<T> = Signal<T> & { set(next: T): void; readonly listenerCount: number };
```

<a id="t-fakesignal-2"></a>

**`fakeSignal`**

```ts
export const fakeSignal = <T>(initial: T): FakeSignal<T> => { … }
```

<a id="t-logline"></a>

**`LogLine`**

```ts
export type LogLine = {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
};
```

<a id="t-faketoast"></a>

**`FakeToast`**

```ts
export type FakeToast = {
  readonly kind: ToastKind;
  readonly message: string;
  readonly detail?: string;
};
```

<a id="t-fakewebctxoptions"></a>

**`FakeWebCtxOptions`**

```ts
export type FakeWebCtxOptions = {
  readonly pluginId?: string;
  readonly locale?: PluginLocale;
  readonly theme?: PluginTheme;
  readonly connection?: PluginConnection;
  readonly activeProject?: string | null;
  readonly projects?: ReadonlyArray<PluginProject>;
  readonly provider?: string | null;
  readonly rpc?: Readonly<Record<string, (payload: unknown) => unknown | Promise<unknown>>>;
  readonly composerTarget?: string | null;
  readonly pickFolder?:
    | string
    | null
    | ((options: PickFolderOptions | undefined) => string | null | Promise<string | null>);
};
```

<a id="t-fakewebctx"></a>

**`FakeWebCtx`**

```ts
export type FakeWebCtx = {
  readonly ctx: WebCtx;
  readonly locale: FakeSignal<PluginLocale>;
  readonly theme: FakeSignal<PluginTheme>;
  readonly connection: FakeSignal<PluginConnection>;
  readonly activeProject: FakeSignal<string | null>;
  readonly projects: FakeSignal<ReadonlyArray<PluginProject>>;
  readonly provider: FakeSignal<string | null>;
  readonly toasts: ReadonlyArray<FakeToast>;
  readonly logs: ReadonlyArray<LogLine>;
  readonly calls: ReadonlyArray<{ readonly method: string; readonly payload: unknown }>;
  readonly closedPanels: ReadonlyArray<string>;
  readonly invalidations: ReadonlyArray<InvalidateSeam>;
  readonly folderPicks: ReadonlyArray<PickFolderOptions | undefined>;
  readonly composerTarget: FakeSignal<string | null>;
  readonly attachments: ReadonlyArray<{
    readonly target: string;
    readonly item: ComposerAttachment;
  }>;
  readonly detachments: ReadonlyArray<{ readonly target: string; readonly id: string }>;
  readonly problems: ReadonlyArray<{ readonly code: string; readonly detail: string }>;
  setState(name: string, value: JsonEncodable | undefined): void;
  stateListenerCount(name: string): number;
  readonly queries: ReadonlyArray<{
    readonly method: string;
    readonly input: unknown;
    readonly cause: QueryRoundCause;
    readonly generation: number;
  }>;
  answerQuery(method: string, answer: JsonEncodable): boolean;
  failQuery(method: string, error?: unknown): boolean;
  readonly activeQueries: number;
};
```

<a id="t-queryroundcause"></a>

**`QueryRoundCause`**

```ts
export type QueryRoundCause = "subscribe" | "reconnect" | "refresh";
```

<a id="t-makefakewebctx"></a>

**`makeFakeWebCtx`**

```ts
export const makeFakeWebCtx = (options: FakeWebCtxOptions = {}): FakeWebCtx => { … }
```

<a id="t-fakeserverctxoptions"></a>

**`FakeServerCtxOptions`**

```ts
export type FakeServerCtxOptions = {
  readonly pluginId?: string;
  readonly dataDir?: string;
  readonly cliConfigDir?: string | null;
  readonly locale?: PluginLocale | (() => PluginLocale);
  readonly projects?:
    | ReadonlyArray<PluginProject>
    | (() => ReadonlyArray<PluginProject> | Promise<ReadonlyArray<PluginProject>>);
  readonly rows?: (sql: string, params: ReadonlyArray<unknown>) => ReadonlyArray<unknown>;
  readonly log?: PluginLogger;
  readonly recordStatements?: boolean;
  readonly storage?: PluginStorage;
  readonly onPublish?: (name: string, value: Json) => void;
};
```

<a id="t-fakestatement"></a>

**`FakeStatement`**

```ts
export type FakeStatement = { readonly sql: string; readonly params: ReadonlyArray<unknown> };
```

<a id="t-fakeserverctx"></a>

**`FakeServerCtx`**

```ts
export type FakeServerCtx = {
  readonly ctx: ServerCtx;
  readonly statements: ReadonlyArray<FakeStatement>;
  readonly logs: ReadonlyArray<LogLine>;
  readonly published: ReadonlyArray<{ readonly name: string; readonly value: Json }>;
  readonly problems: ReadonlyArray<{ readonly code: string; readonly detail: string }>;
};
```

<a id="t-makefakeserverctx"></a>

**`makeFakeServerCtx`**

```ts
export const makeFakeServerCtx = (options: FakeServerCtxOptions = {}): FakeServerCtx => { … }
```

<a id="t-fakerpcrejection"></a>

**`fakeRpcRejection`**

```ts
export const fakeRpcRejection = (reason: string, detail?: string, data?: Json): unknown => ({ … })
```

**Веб-фейк.** Умолчания: `pluginId: "demo"`, `locale: "en"`, `theme: "light"`, `connection: "ready"`, `activeProject: null`, `projects: []`, `provider: null`, `composerTarget: "draft:test"`, `pickFolder: null`.

- `invoke` вызывает обработчик из `rpc`; метод без обработчика отклоняется `unknown-method`; парковки, лимита и `transport` у `invoke` нет. Вызовы записываются в `calls`;
- `invalidate` и `closePanel` записываются (`invalidations`, `closedPanels`), а не выполняются;
- `state(name)` — настоящая ячейка приложения; значение задаёт `setState(name, value)` (применяется только при структурном отличии; `undefined` — «на сервере значения нет»); проблемы — в `problems` (`state-name-invalid`, `cap:state-names`, `state-listener-threw`);
- `query` — настоящее правило приложения поверх фейкового транспорта: раунд при `connection` ≠ `"ready"` ждёт, раунд в пути при уходе из `"ready"` отклоняется `transport`, так что `connection.set("lost")` + `connection.set("ready")` — переподключение. Раунды — в `queries` (не в `calls`); метод без `rpc` ждёт `answerQuery` / `failQuery`; `problems` получает `cap:queries`, `query-listener-threw`;
- `pickFolder` применяет правило «один ожидающий на плагин»: второй вызов без ожидания первого сразу `null`; все вызовы — в `folderPicks`; ответ всегда разрешается микрозадачей позже;
- `composer.attach` заменяет запись с тем же `id`; `attachments`, `detachments` записываются;
- лимиты швов, правило отображаемых строк и слагов не применяются — это делает песочница.

**Серверный фейк.** `storage` записывает операторы в `statements` и отвечает `rows(sql, params)` (по умолчанию `[]`); `storage` из опций подменяет его настоящим хранилищем при продолжающейся записи. `locale` по умолчанию `"ru"`; `projects` — массив или функция; `paths.dataDir` по умолчанию `/tmp/ru-code/plugins/<id>`, `cliConfigDir` — `/tmp/ru-code/.qwen`. `publish` применяет проверки приложения в его порядке; принятые публикации — в `published` (включая повторы), отказы — один раз на код в `problems` (`state-name-invalid`, `cap:state-names`, `state-value-invalid`, `cap:state-value-bytes`).

```ts
import { expect, it } from "vite-plus/test";
import { makeFakeServerCtx, makeFakeWebCtx } from "@smart-tools/plugin-sdk/testing";
import plugin from "../src/server/index.ts";

it("the panel asks the server and re-asks the composer", async () => {
  const web = makeFakeWebCtx({ rpc: { "notes.list": () => [{ id: 1, body: "hi" }] } });
  await refreshNotes(web.ctx);
  expect(web.calls).toEqual([{ method: "notes.list", payload: undefined }]);
  expect(web.invalidations).toEqual(["composer"]);
});

it("notes.list selects from its table", async () => {
  const server = makeFakeServerCtx({ rows: () => [{ id: 1, body: "hi" }] });
  await plugin.rpc?.["notes.list"]?.(undefined, server.ctx);
  expect(server.statements[0]?.sql).toContain("FROM notes");
});

it("state follows the published value", () => {
  const web = makeFakeWebCtx();
  const count = web.ctx.state("notes.count");
  web.setState("notes.count", { count: 3 });
  expect(count.get()).toEqual({ count: 3 });
});
```

<a id="testing-node"></a>

### testing/node — помощники с диском и SQLite

<a id="t-importsof"></a>

**`importsOf`**

```ts
export const importsOf = (file: string): ReadonlyArray<string> => { … }
```

<a id="t-pluginbundle"></a>

**`PluginBundle`**

```ts
export interface PluginBundle {
  readonly root: string;
  readonly distDir: string;
  readonly hasDist: boolean;
  readonly webEntry: string;
  readonly serverEntry: string;
  readonly hasServer: boolean;
  readonly webImports: ReadonlyArray<string>;
  readonly serverImports: ReadonlyArray<string>;
  readonly manifest: unknown;
  readonly sizeOf: (relative: string) => number;
  readonly textOf: (relative: string) => string;
}
```

<a id="t-readpluginbundle"></a>

**`readPluginBundle`**

```ts
export const readPluginBundle = (root: string): PluginBundle => { … }
```

<a id="t-sqlitelogline"></a>

**`SqliteLogLine`**

```ts
export type SqliteLogLine = {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>> | undefined;
};
```

<a id="t-sqliteserverctxoptions"></a>

**`SqliteServerCtxOptions`**

```ts
export type SqliteServerCtxOptions = {
  readonly pluginId?: string;
  readonly cliConfigDir?: string | null;
  readonly dataDir?: "temp" | string;
  readonly projects?: ReadonlyArray<PluginProject>;
  readonly locale?: PluginLocale;
};
```

<a id="t-sqliteserverctx"></a>

**`SqliteServerCtx`**

```ts
export type SqliteServerCtx = {
  readonly ctx: ServerCtx;
  readonly db: DatabaseSync;
  readonly logs: ReadonlyArray<SqliteLogLine>;
  readonly statements: ReadonlyArray<string>;
  readonly published: FakeServerCtx["published"];
  readonly publishProblems: FakeServerCtx["problems"];
  readonly dataDir: string;
  runMigrations(migrations: ReadonlyArray<Migration>): void;
  close(): void;
};
```

<a id="t-makesqliteserverctx"></a>

**`makeSqliteServerCtx`**

```ts
export const makeSqliteServerCtx = (options: SqliteServerCtxOptions = {}): SqliteServerCtx => { … }
```

- `readPluginBundle(root)` читает собранную папку (`root` — пакет, не `dist`); `hasDist` определяется по веб-части; для отсутствующих файлов `sizeOf` / `textOf` дают `0` / `""`, `manifest` — `null`;
- `importsOf(file)` — все «голые» спецификаторы, которые файл ESM ещё импортирует, отсортированы и без повторов;
- `makeSqliteServerCtx` — `ServerCtx` с настоящей SQLite в памяти (`node:sqlite`): строки возвращаются с обычным прототипом; `exec` с параметрами выполняет только первый оператор, как в приложении; `dataDir: "temp"` создаёт временную папку, удаляемую в `close()`.

```ts
import { afterEach, expect, it } from "vite-plus/test";
import { makeSqliteServerCtx } from "@smart-tools/plugin-sdk/testing/node";
import plugin from "../src/server/index.ts";

const sqlite = makeSqliteServerCtx({ pluginId: "notes" });
afterEach(() => sqlite.close());

it("migrations and handlers agree", async () => {
  sqlite.runMigrations(plugin.migrations ?? []);
  await plugin.rpc?.["notes.add"]?.({ body: "hi" }, sqlite.ctx);
  expect(await plugin.rpc?.["notes.list"]?.(undefined, sqlite.ctx)).toHaveLength(1);
});
```

<a id="testing-config"></a>

### Конфиг тестов

<a id="t-plugin-test-dedupe"></a>

**`PLUGIN_TEST_DEDUPE`**

```ts
export const PLUGIN_TEST_DEDUPE: ReadonlyArray<string> = [
  "react",
  "react-dom",
  "zustand",
  "lucide-react",
  "@base-ui/react",
];
```

<a id="t-plugintestconfigoptions"></a>

**`PluginTestConfigOptions`**

```ts
export interface PluginTestConfigOptions {
  readonly dedupe?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly passWithNoTests?: boolean;
  readonly projects?: ReadonlyArray<TestProjectInlineConfiguration>;
}
```

<a id="t-plugintestconfig"></a>

**`pluginTestConfig`**

```ts
export const pluginTestConfig = (options: PluginTestConfigOptions = {}): unknown => { … }
```

Проект `unit` собирает `tests/**/*.test.{ts,tsx}`, тайм-аут по умолчанию 60 с; `dedupe` добавляется к `PLUGIN_TEST_DEDUPE`, а не заменяет его.

```ts
// vite.config.ts
import { pluginTestConfig } from "@smart-tools/plugin-dev/test";

export default pluginTestConfig({ dedupe: ["recharts"] });
```

<a id="playground"></a>

## 12. Песочница

Песочница `@smart-tools/plugin-dev` запускает веб-часть плагина с горячей заменой и **настоящую** серверную часть над временной SQLite, рисует каждый шов, показывает сигналы и значения `publish`, применяет лимиты и проверки приложения и показывает, **почему** элемент отброшен. Есть переключатели сбоев: исключение в поверхности, отказ следующего `invoke`, медленный `invoke`.

```ts
// vite.playground.config.ts
import { pluginDevConfig } from "@smart-tools/plugin-dev/playground";

export default pluginDevConfig({ root: import.meta.dirname });
```

```json
{
  "scripts": {
    "build": "tsdown",
    "dev": "plugin-playground --root .",
    "test": "vp test run",
    "test:e2e": "playwright test",
    "install-local": "plugin-install-local"
  }
}
```

<a id="t-plugindevconfig"></a>

**`pluginDevConfig`**

```ts
export const pluginDevConfig = async (options: PluginDevOptions): Promise<PluginDevConfig> => { … }
```

<a id="t-plugindevconfig-2"></a>

**`PluginDevConfig`**

```ts
export type PluginDevConfig = Record<string, unknown>;
```

<a id="t-pluginpackageoptions"></a>

**`PluginPackageOptions`**

```ts
export type PluginPackageOptions = {
  readonly root: string;
  readonly manifest?: string;
  readonly server?: "source" | "dist" | string | false;
  readonly web?: string | false;
  readonly styles?: string | false;
};
```

<a id="t-plugindevoptions"></a>

**`PluginDevOptions`**

```ts
export type PluginDevOptions = PluginPackageOptions & {
  readonly port?: number;
  readonly bridgePort?: number;
  readonly tmpDir?: string;
  readonly tailwindSources?: ReadonlyArray<string>;
  readonly open?: boolean;
  readonly onServer?: (server: PlaygroundServer) => void;
};
```

- `pnpm dev` держит временное дерево в `<root>/.playground` между запусками (база данных сохраняется);
- в свежем дереве два тестовых проекта `proj-alpha` и `proj-beta` (их `cwd` создаются во временном дереве), активен первый; список можно править в песочнице;
- серверная часть по умолчанию берётся из исходников (`src/server/index.ts`), `server: "dist"` — из сборки;
- плагин без веб-части `pluginDevConfig` не запускает — такой плагин проверяется e2e-фикстурой.

<a id="playground-json"></a>

### playground.json

Необязательный файл `playground.json` в корне пакета (рядом с `package.json`) задаёт начальное состояние `pnpm dev`. Файл не коммитят; в репозиторий кладут `playground.example.json`. Все ключи необязательны; без файла песочница работает как описано выше.

```json
{
  "projects": [{ "id": "billing", "name": "Billing", "cwd": "~/work/billing" }],
  "activeProject": "billing",
  "locale": "ru",
  "theme": "dark",
  "connection": "ready",
  "storage": "persist"
}
```

<a id="t-playground-file"></a>

**`PLAYGROUND_FILE`**

```ts
export const PLAYGROUND_FILE = "playground.json";
```

<a id="t-playgroundstorage"></a>

**`PlaygroundStorage`**

```ts
export type PlaygroundStorage = "persist" | "fresh";
```

<a id="t-playgroundstart"></a>

**`PlaygroundStart`**

```ts
export type PlaygroundStart = {
  readonly projects?: ReadonlyArray<PluginProject>;
  readonly activeProject?: string;
  readonly locale?: PluginLocale;
  readonly theme?: PluginTheme;
  readonly connection?: PluginConnection;
  readonly storage?: PlaygroundStorage;
};
```

| ключ            | значение                                | правило                                                                                                                                                                                                               |
| --------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`      | `[{ "id", "name", "cwd" }]`             | заменяет тестовые проекты и записывается при каждом запуске; `id`, `name`, `cwd` — непустые строки, `id` не повторяются; `cwd` абсолютный или `~` / `~/…`; проект, чей `cwd` не каталог, пропускается с записью в лог |
| `activeProject` | id из списка                            | непустая строка; неизвестный id — запись в лог, активен первый проект                                                                                                                                                 |
| `locale`        | `"en"` \| `"ru"`                        | начальное значение; переключатель песочницы продолжает работать                                                                                                                                                       |
| `theme`         | `"light"` \| `"dark"`                   | начальное значение                                                                                                                                                                                                    |
| `connection`    | `"connecting"` \| `"ready"` \| `"lost"` | начальное значение, применяется при первом ответе моста                                                                                                                                                               |
| `storage`       | `"persist"` \| `"fresh"`                | `persist` (по умолчанию) — `.playground` сохраняется; `fresh` — SQLite и папка данных плагина в `.playground` очищаются при запуске                                                                                   |

- файл не JSON или неверный ключ — `pnpm dev` останавливается с **одной** ошибкой, называющей ключ и причину;
- неизвестный ключ записывается в лог и игнорируется;
- файл читается только для дерева `.playground` команды `pnpm dev`; e2e-фикстура загружает своё свежее дерево и файл не читает.

<a id="playground-e2e"></a>

### e2e: pluginE2eConfig

```ts
// playwright.config.ts
import { pluginE2eConfig } from "@smart-tools/plugin-dev/e2e";

export default pluginE2eConfig({ root: import.meta.dirname });
```

<a id="t-plugine2econfig"></a>

**`pluginE2eConfig`**

```ts
export const pluginE2eConfig = (options: PluginE2eOptions): PluginE2eConfig => { … }
```

<a id="t-plugine2econfig-2"></a>

**`PluginE2eConfig`**

```ts
export type PluginE2eConfig = Record<string, unknown>;
```

<a id="t-plugine2eoptions"></a>

**`PluginE2eOptions`**

```ts
export type PluginE2eOptions = {
  readonly root: string;
  readonly testDir?: string;
  readonly artifacts?: string;
  readonly timeout?: number;
};
```

<a id="t-test"></a>

**`test`**

```ts
export const test = base.extend<{ plugin: PluginHarness }>({ … })
```

<a id="t-composerrowview"></a>

**`ComposerRowView`**

```ts
export type ComposerRowView = {
  readonly id: string;
  readonly label: string;
  readonly dropped: string | null;
};
```

<a id="t-playgroundhandshake"></a>

**`PlaygroundHandshake`**

```ts
export type PlaygroundHandshake = {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly version: string;
  readonly webUrl: string;
  readonly controlUrl: string;
  readonly wsUrl: string;
  readonly tmpDir: string;
  readonly dataDir: string;
  readonly cliConfigDir: string;
  readonly root: string;
  readonly pid: number;
};
```

<a id="t-playgroundserverstate"></a>

**`PlaygroundServerState`**

```ts
export type PlaygroundServerState = "loaded" | "failed" | "skipped";
```

<a id="t-playgroundstatus"></a>

**`PlaygroundStatus`**

```ts
export type PlaygroundStatus = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly state: PlaygroundServerState;
  readonly error?: string;
  readonly hasWeb: boolean;
  readonly hasServer: boolean;
  readonly serverEntry?: string;
  readonly dataDir: string;
  readonly cliConfigDir: string | null;
  readonly migrations: ReadonlyArray<string>;
  readonly restarts: number;
};
```

<a id="t-playgroundlogline"></a>

**`PlaygroundLogLine`**

```ts
export type PlaygroundLogLine = {
  readonly at: string;
  readonly level: "info" | "warn" | "error";
  readonly source: "plugin" | "playground" | "stdout";
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
};
```

<a id="t-pluginharness"></a>

**`PluginHarness`**

```ts
export class PluginHarness {
  readonly page: Page;
  readonly handshake: PlaygroundHandshake;
  open(): Promise<void>;
  openPage(id: string): Promise<Locator>;
  openPanel(id: string): Promise<Locator>;
  closePanel(): Promise<void>;
  openTab(id: string): Promise<Locator>;
  closeTab(): Promise<void>;
  switchThread(): Promise<void>;
  setPanelWidth(px: number): Promise<number>;
  panelWidthRange(): Promise<{ readonly min: number; readonly max: number }>;
  panelWidth(): Promise<number>;
  composer(trigger: ComposerTrigger, query = ""): Promise<ReadonlyArray<ComposerRowView>>;
  selectRow(id: string): Promise<string>;
  invoke<Result = unknown>(method: string, payload?: unknown): Promise<Result>;
  setSignal(
    name: "locale" | "theme" | "connection" | "activeProject" | "provider" | "projects",
    value: string | ReadonlyArray<PluginProject>,
  ): Promise<void>;
  setFault(fault: {
    readonly throwIn?: string | null;
    readonly rejectNextInvoke?: boolean;
    readonly slowInvoke?: boolean;
  }): Promise<void>;
  surfaceFailure(): Locator;
  toasts(): Locator;
  seedDataDir(files: Readonly<Record<string, string | null>>): Promise<unknown>;
  seedCliConfigDir(files: Readonly<Record<string, string | null>>): Promise<unknown>;
  status(): Promise<PlaygroundStatus>;
  restartServer(): Promise<PlaygroundStatus>;
  fingerprint(threadId: string, projectId: string | null): Promise<string | null>;
  provision(projectId: string, targetCwd: string): Promise<void>;
  setProjects(projects: ReadonlyArray<PluginProject>): Promise<void>;
  logs(): Promise<ReadonlyArray<PlaygroundLogLine>>;
}
```

- песочница загружается один раз на весь набор (global setup) над свежим временным деревом; фикстура `plugin` на каждый тест открывает страницу и ждёт её монтирования;
- один воркер, без параллельности и без повторов; спеки — `e2e/**/*.e2e.test.ts`; тайм-аут теста по умолчанию 120 с; трассы, видео, лог и временное дерево — в `<root>/.artifacts-e2e/`;
- методы страницы (`openPage`, `openPanel`, `composer`, `selectRow`, `setSignal`, `invoke`) работают через настоящую страницу; `invoke` идёт страница → websocket → плагин, и отказ приходит в `cause` как `{ _tag, reason, detail?, data? }`;
- управляющие методы (`status`, `restartServer`, `fingerprint`, `provision`, `seedDataDir`, `seedCliConfigDir`, `logs`, `setProjects`) идут прямо в серверную часть песочницы по HTTP и работают без открытой страницы;
- `setFault({ throwIn })` принимает `page:<id>` или `panel:<id>`.

```ts
// e2e/notes.e2e.test.ts
import { expect, test } from "@smart-tools/plugin-dev/e2e";

test("the panel lists what the server stored", async ({ plugin }) => {
  await plugin.invoke("notes.add", { body: "hello" });
  const panel = await plugin.openPanel("notes");
  await expect(panel.getByText("hello")).toBeVisible();
  const rows = await plugin.composer("/", "notes");
  expect(rows.map((row) => row.dropped)).toEqual([null]);
});
```

<a id="shipping"></a>

## 13. Поставка

**Пользовательский плагин.** Собрать и установить командой `install-local`, затем перезапустить приложение:

```sh
pnpm build
pnpm install-local   # plugin-install-local
```

`plugin-install-local` запускается из корня пакета плагина: читает `id` из `dist/plugin.json` (проверяет шаблон id), **удаляет** прежнюю папку `<RU_CODE_PLUGINS_DIR или ~/.ru-code/plugins>/<id>` и копирует туда `dist/` целиком, затем печатает список установленных файлов. Без `dist/` или `dist/plugin.json` завершается с ошибкой.

**Поставляемый плагин.** Путь к папке плагина (папке, которая и есть плагин, обычно `…/dist`) добавляется в `ru-code/packaging/shipped-plugins.json` репозитория приложения. Пути относительны корню приложения или абсолютны и могут проходить через символическую ссылку на соседний репозиторий. При сборке приложения папка **копируется** (без символических ссылок) в `<dest>/<manifest id>` и попадает в пакет версии до расчёта контрольных сумм.

- путь, которого нет, который не каталог, без `plugin.json` или с нераскодируемым `plugin.json`, записывается в лог и пропускается; сборка не падает;
- при повторе id выигрывает первая запись;
- неверный по форме сам список — ошибка сборки;
- поставляемый плагин пользователь не удаляет (он возвращается с обновлением), а выключает переключателем ([Включение и выключение](#switches)).

Текущий список:

```json
{
  "plugins": [
    "ru-code-plugin-auto-coder/dist",
    "ru-code-packages/packages/plugin-analytics/dist",
    "ru-code-packages/packages/plugin-catalogs/dist",
    "ru-code-packages/packages/plugin-project-settings/dist",
    "ru-code-packages/packages/plugin-demo/dist",
    "ru-code-packages/packages/t3-code-pixso-mcp-assistant-plugin/dist"
  ]
}
```

**Плагин в отдельном репозитории.** Репозиторий и есть пакет плагина (пример — `plugin-auto-coder`):

| файл                              | содержимое                                                                |
| --------------------------------- | ------------------------------------------------------------------------- |
| `package.json`                    | скрипты `build`, `typecheck`, `test`, `test:e2e`, `dev`, `install-local`  |
| `src/plugin.json`                 | манифест; сборка кладёт его в корень `dist/`                              |
| `tsconfig.{server,web,test}.json` | `extends: ["./tsconfig.base.json", "@smart-tools/plugin-sdk/tsconfig/…"]` |
| `tsdown.config.ts`                | `pluginBuildConfig({ root })`                                             |
| `vite.config.ts`                  | `pluginTestConfig()`                                                      |
| `vite.playground.config.ts`       | `pluginDevConfig({ root })`                                               |
| `playwright.config.ts`            | `pluginE2eConfig({ root })`                                               |

- `@smart-tools/plugin-sdk` и `@smart-tools/plugin-dev` — devDependencies; приложение ни один из них не устанавливает;
- `react`, `react-dom`, `effect`, `zustand` объявляются как peer-зависимости на мажорных версиях общих модулей;
- `test:e2e` можно не заводить, если поверхность не рендерится без внешнего сервиса на фиксированном порту.
