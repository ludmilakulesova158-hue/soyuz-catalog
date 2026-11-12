# soyuz-catalog

Каталог объектов АН «Союз» (Калуга): каждые 30 минут GitHub Actions забирает
XML-фид JoyWork и публикует компактный JSON для сайта soyuzkaluga.ru.

## Что здесь

- `scripts/convert.mjs` — конвертер Yandex Realty XML → JSON (без зависимостей)
- `.github/workflows/update.yml` — автообновление по расписанию
- `data/` — сгенерированные данные (обновляются роботом)

## Ссылки для сайта

- Список карточек: `https://raw.githubusercontent.com/ludmilakulesova158-hue/soyuz-catalog/main/data/cards.json`
- Метаданные (кол-во, дата обновления): `https://raw.githubusercontent.com/ludmilakulesova158-hue/soyuz-catalog/main/data/meta.json`
- Полный объект по ID: `https://raw.githubusercontent.com/ludmilakulesova158-hue/soyuz-catalog/main/data/objects/<id>.json`

## Защита от сбоев

- Если фид отдал 0 объектов или объектов стало меньше половины — данные не перезаписываются,
  сайт продолжает показывать последнюю корректную версию.
- Запустить обновление вручную: Actions → update-catalog → Run workflow.
