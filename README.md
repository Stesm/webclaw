<h1 align="center">🦀 webclaw — web-first форк ZeroClaw</h1>

<p align="center">
  <strong>ZeroClaw, управляемый целиком из веб-дашборда — без обязательного канала.</strong>
</p>

> **Это форк.** `webclaw` — независимый, неаффилированный форк проекта
> [**zeroclaw-labs/zeroclaw**](https://github.com/zeroclaw-labs/zeroclaw).
> Апстрим-рантайм сохранён без изменений; этот форк добавляет поверх него
> web-first workflow. Вся документация по установке, развёртыванию, настройке
> и использованию — в апстрим-репозитории, ссылки ниже.
>
> Зеркала: [github.com/Stesm/webclaw](https://github.com/Stesm/webclaw) ·
> [git.alfastat.ru/root/webclaw](https://git.alfastat.ru/root/webclaw)
>
> База: upstream `master` @ `d8d5d93f5` (пакет `v0.8.5`) + короткий стек
> коммитов форка в ветке `fork-work`.

<p align="center">
  <a href="LICENSE-APACHE"><img src="https://img.shields.io/badge/license-MIT%20OR%20Apache%202.0-blue.svg" alt="License" /></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/rust-edition%202024-orange?logo=rust" alt="Rust Edition 2024" /></a>
</p>

<p align="center">
  <a href="https://github.com/zeroclaw-labs/zeroclaw">Апстрим</a> ·
  <a href="https://docs.zeroclaw.com/master/en/introduction.html">Документация апстрима</a> ·
  <a href="docs/book/src/getting-started/quickstart.md">Quick start апстрима</a> ·
  <a href="https://github.com/zeroclaw-labs/zeroclaw/issues">Issues апстрима</a>
</p>

---

## Что это за форк

ZeroClaw — это агентный рантайм: один Rust-бинарь, который общается с
LLM-провайдерами, выходит в мир через 30+ каналов и действует при помощи
инструментов. Апстрим предполагает, что к агенту обращаются через канал
(Discord, Telegram, Matrix, email, …) или терминал.

Этот форк делает **веб-дашборд основным клиентом**. Вы настраиваете провайдера и
агента, поднимаете gateway — и управляете агентом из браузера. Chat-канал для
работы основного цикла не нужен. Вокруг этой идеи форк закрывает ряд проблем
поведения web-клиента в апстрим-gateway и дашборде.

Всё остальное — провайдеры, инструменты, память, политика безопасности, SOP-движок,
hardware, ACP — это апстрим без изменений.

## Отличия форка

### Web-first, работа без канала
- **Канал не обязателен.** Агент полностью управляется через web-клиент gateway;
  адаптеры Discord / Telegram / Matrix / email опциональны. *(коммит `9f2da7892`)*

### Фоновые turn'ы (агент переживает закрытие вкладки)
- **Turn'ы выживают отключение клиента.** Закрытие или переключение вкладки
  браузера больше не отменяет выполняющийся turn — агент продолжает работу на
  сервере, сохраняет ответ, а вернувшийся клиент его перегидрирует. Явная кнопка
  **Stop** по-прежнему отменяет. *(снятие WS `cancel` при close в `9f2da7892`;
  отмена abort при переключении сессии — `2950846c8`)*
- **Ответ фонового turn'а доходит до открытого чата.** Broadcast `turn_done`
  заставляет вернувшийся посреди turn'а клиент сам перегидрировать транскрипт,
  вместо «зависшей» сессии с индикатором набора. *(в `9f2da7892`)*
- **Промежуточный ответ сохраняется на Stop.** Прерывание turn'а сохраняет уже
  видимый оператору текст, а не оставляет только `[interrupted by user]`.
  *(коммит `04caff5cf`)*

### Дашборд
- **Расширенный список диалогов.** Список сессий показывает превью первого
  сообщения, поддерживает переименование на месте и deep-link прямо в панель чата.
- **Все сессии агента и живой лог крона.** Селектор сессий показывает каждую
  сессию агента: канальные (например, Mattermost) открываются **только на
  просмотр** в вьюере транскрипта, gateway-сессии — для ввода. У cron-джоб есть
  кнопка **«Лог прогона»**, открывающая текущий/последний прогон агента как
  чат-транскрипт с живым поллингом, пока прогон идёт.
  *(коммиты `e30ca9ca`, `c4d899d2`)*
- **Стабильные ключи треда.** Live-прогресс turn'а больше не перемонтирует
  (и не проигрывает анимацию появления) весь тред на каждом обновлении.
  *(коммит `82a9f2411`)*

### Вложения и PWA
- **Вложения от агента с превью.** Агент может отправлять файлы клиенту; они
  рендерятся инлайн-карточками с модалом превью. Content-Security Policy
  разрешает `blob:` для превью картинок. *(коммит `b5e8acbbb`)*
- **PWA-манифест.** Дашборд устанавливается как standalone web-приложение
  (манифест + иконки + `theme-color`). *(коммит `be0feefc6`)*

## Установка и запуск

Сборка, установка, настройка и эксплуатация этого форка — **ровно как в
апстриме**, см.:

- **Установка** — апстрим [`README → Install`](https://github.com/zeroclaw-labs/zeroclaw#install) и [installation guide](https://docs.zeroclaw.com/master/en/getting-started/quickstart.html#install)
- **Quick start** — апстрим [Quick start](docs/book/src/getting-started/quickstart.md) (`zeroclaw quickstart`, затем `zeroclaw agent -a <alias>`)
- **Развёртывание / сервис** — апстрим [гайды по setup](docs/book/src/setup/linux.md) (Linux · macOS · Windows · FreeBSD · NixOS · Docker) и `zeroclaw service install|start`
- **Gateway и дашборд** — апстрим-документация [Gateway](docs/book/src/architecture/overview.md); отличия этого форка предполагают веб-дашборд как клиент
- **Конфигурация** — апстрим [`~/.zeroclaw/config.toml` reference](https://docs.zeroclaw.com/master/en/reference/config.html)

### Сборка этого форка

Единственная fork-специфичная деталь сборки — web-клиент и изменения поведения
дашборда живут в `web/`, поэтому фронтенд-бандл надо собирать вместе с бэкендом.
Используйте апстрим-тулчейн и набор фич, например:

```bash
git clone https://github.com/Stesm/webclaw.git && cd webclaw
git checkout fork-work

# backend (подправьте --features под реально используемые каналы)
cargo build --release --features "gateway"

# frontend (Node 24+)
source ~/.nvm/nvm.sh && nvm use 24
cd web && npm ci && npm run build
```

Развёртывание, регистрация сервиса, reverse-proxy/TLS — это апстрим-темы,
следуйте гайдам по setup из ссылок выше.

## Апстрим и предупреждение о подмене

Апстрим-проект поддерживается здесь:

> <https://github.com/zeroclaw-labs/zeroclaw>

Этот форк — независимая, неаффилированная производная того проекта. Имя и логотип
**ZeroClaw** остаются торговыми марками ZeroClaw Labs. Не сообщайте об issues
этого форка в апстрим; см. зеркала выше.

## Лицензия

Двойное лицензирование: [MIT](LICENSE-MIT) ИЛИ [Apache 2.0](LICENSE-APACHE). Вы
можете выбрать любую. Контрибьюторы автоматически предоставляют права по обеим —
см. [CLA](docs/book/src/contributing/cla.md). Имя и логотип **ZeroClaw** —
торговые марки ZeroClaw Labs.

## Благодарности

Рантайм построен и поддерживается апстрим-сообществом ZeroClaw — автор идеи
[@theonlyhennygod](https://github.com/theonlyhennygod); лид проекта
[@JordanTheJet](https://github.com/JordanTheJet). Полный список мейнтейнеров в
[Communication](docs/book/src/contributing/communication.md). Этот форк следит
за тем проектом и добавляет описанный выше web-first слой.
