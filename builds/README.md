# builds — готовые сборки webclaw

Собрано из этого репозитория: commit `b2829fc32`,
версия `zeroclaw 0.9.0 (v0.8.6-97-gb2829fc32)`.

Команда сборки: `cargo build --release --locked -p zeroclaw`
(профиль `release` из `Cargo.toml`: `opt-level=z`, `lto=fat`, `codegen-units=1`).

| файл | платформа | назначение |
|---|---|---|
| `zeroclaw-x86_64-apple-darwin.tar.gz` | macOS x86_64 | Mac mini |
| `zeroclaw-aarch64-unknown-linux-musl.tar.gz` | linux arm64, статик (musl) | контейнер shelfy-trader (glibc-независимый) |
| `SHA256SUMS` | — | контрольные суммы архивов |

Внутри каждого архива — бинарь `zeroclaw`. Проверка:

    shasum -a 256 -c SHA256SUMS
    tar xzf zeroclaw-<платформа>.tar.gz && ./zeroclaw --version
    # zeroclaw 0.9.0 (v0.8.6-97-gb2829fc32)