/**
 * Google Apps Script — создаёт ДВЕ онбординг-формы для нового клиента посуточной аренды.
 *
 * Почему две формы: у клиента часто несколько объектов (3+). Бизнес-правила
 * (тон, отмена, торг) у него обычно одни на все квартиры, а данные объекта
 * (адрес, код двери, wifi) — свои у каждой. Поэтому:
 *   - Форма 1 «Бизнес-правила» — заполняется ОДИН раз на клиента → customPrompt
 *   - Форма 2 «Карточка объекта» — заполняется на КАЖДУЮ квартиру → поля Property
 *
 * КАК ЗАПУСТИТЬ:
 * 1. Открой https://script.google.com → New project
 * 2. Удали весь код, вставь этот файл целиком
 * 3. Выбери в выпадающем списке функцию createAllForms → Run (▶)
 * 4. Разреши доступ к своему аккаунту
 * 5. Ссылки на обе формы появятся в логах (View → Logs / Ctrl+Enter)
 *
 * Структура совпадает с tasks/client-onboarding-brief.md.
 */

function createAllForms() {
  createBusinessRulesForm();
  createPropertyForm();
}

// ════════════════════════════════════════════════════════════════════════════
// ФОРМА 1 — БИЗНЕС-ПРАВИЛА (один раз на клиента → customPrompt)
// ════════════════════════════════════════════════════════════════════════════
function createBusinessRulesForm() {
  const form = FormApp.create('AvitoBot — правила вашего бизнеса')
    .setDescription(
      'Заполните один раз. Эти правила бот применит ко всем вашим объектам. ' +
      'Данные конкретных квартир (адрес, код двери, wifi) — в отдельной анкете «Карточка объекта».'
    )
    .setProgressBar(true)
    .setCollectEmail(false);

  // ─── Контакты ───────────────────────────────────────────────────────────────
  form.addSectionHeaderItem().setTitle('Контакты для связи');

  form.addTextItem()
    .setTitle('Имя владельца / контактного лица')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Телефон или Telegram для связи с вами')
    .setHelpText('Гостям НЕ показывается. Нужен нам для настройки и уведомлений.')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Куда боту слать уведомление, когда нужен живой оператор?')
    .setHelpText('Telegram-аккаунт или чат, куда придёт алерт «гость ждёт человека».')
    .setRequired(false);

  // ─── Раздел 1. О бизнесе и тоне ─────────────────────────────────────────────
  form.addSectionHeaderItem().setTitle('1. О бизнесе и общении');

  form.addTextItem()
    .setTitle('Как зовут вашего бота-менеджера?')
    .setHelpText('Имя, которое увидит гость в переписке. Например: Анна, Эльза, Максим.')
    .setRequired(true);

  form.addTextItem()
    .setTitle('В каком городе / районе работаете?')
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Как бот должен общаться с гостями?')
    .setChoiceValues([
      'Дружелюбно и тепло, на «вы»',
      'Деловито и кратко, на «вы»',
      'Неформально, на «ты»',
    ])
    .showOtherOption(true)
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Есть ли слова или тон, которых бот точно НЕ должен использовать?')
    .setHelpText('Необязательно. Например: не шутить, не использовать уменьшительные слова.')
    .setRequired(false);

  // ─── Раздел 2. Бронирование и оплата ────────────────────────────────────────
  form.addSectionHeaderItem().setTitle('2. Бронирование и оплата');

  form.addParagraphTextItem()
    .setTitle('Что бот отвечает, когда гость хочет забронировать?')
    .setHelpText('Необязательно. Если оставите пустым — подставим стандарт «предоплата через Авито».')
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('Берёте ли предоплату?')
    .setChoiceValues(['Да, всю сумму', 'Да, часть', 'Нет'])
    .setRequired(true);

  // ─── Раздел 3. Отмена и возврат ─────────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle('3. Отмена и возврат')
    .setHelpText('Важно: у каждого объекта свои условия — укажите ваши.');

  form.addMultipleChoiceItem()
    .setTitle('За сколько дней до заезда отмена бесплатная?')
    .setChoiceValues(['7 дней', '3 дня', '1 день', 'Бесплатной отмены нет'])
    .showOtherOption(true)
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Что происходит при поздней отмене (меньше срока выше)?')
    .setChoiceValues([
      'Предоплата не возвращается',
      'Возвращается частично',
      'Возвращается полностью',
    ])
    .showOtherOption(true)
    .setRequired(true);

  form.addTextItem()
    .setTitle('За сколько дней деньги возвращаются гостю?')
    .setHelpText('Например: 5 рабочих дней.')
    .setRequired(false);

  // ─── Раздел 4. Цена и торг ──────────────────────────────────────────────────
  form.addSectionHeaderItem().setTitle('4. Цена и торг');

  form.addMultipleChoiceItem()
    .setTitle('Как бот реагирует на просьбу о скидке?')
    .setChoiceValues([
      'Скидку не даём',
      'Скидка за длительное проживание (от N ночей)',
      'Скидка на следующее заселение за отзыв',
    ])
    .showOtherOption(true)
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Если есть условие скидки — опишите точно')
    .setHelpText('Необязательно. От скольки ночей, сколько процентов и т.п.')
    .setRequired(false);

  // ─── Раздел 5. Заезд / выезд (по умолчанию) ─────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle('5. Заезд и выезд')
    .setHelpText('Время по умолчанию. Если у конкретной квартиры оно другое — укажете в её карточке.');

  form.addTextItem()
    .setTitle('Время заезда?')
    .setHelpText('Например: с 15:00.')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Время выезда?')
    .setHelpText('Например: до 12:00.')
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Возможен ли ранний заезд / поздний выезд? На каких условиях?')
    .setRequired(false);

  // ─── Раздел 6. Продление и ранний выезд ─────────────────────────────────────
  form.addSectionHeaderItem().setTitle('6. Продление и ранний выезд');

  form.addParagraphTextItem()
    .setTitle('Как бот отвечает на «можно продлить проживание»?')
    .setHelpText('Например: «Уточню свободны ли даты и вернусь» или «Да, доплата за ночь N руб».')
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('Если гость съезжает раньше — возвращаете деньги за неиспользованные ночи?')
    .setChoiceValues(['Да, полностью', 'Да, частично', 'Нет', 'По ситуации'])
    .showOtherOption(true)
    .setRequired(true);

  // ─── Раздел 7. Правила (общие для всех объектов) ────────────────────────────
  form.addSectionHeaderItem()
    .setTitle('7. Общие правила')
    .setHelpText('Если у какой-то квартиры правила особые — укажете в её карточке.');

  form.addMultipleChoiceItem()
    .setTitle('Можно ли с животными?')
    .setChoiceValues(['Да', 'Нет', 'По согласованию'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Можно ли курить?')
    .setChoiceValues(['Да', 'Нет', 'Только на балконе'])
    .setRequired(true);

  form.addTextItem()
    .setTitle('Есть ли депозит? Сколько и когда возвращается?')
    .setRequired(false);

  form.addParagraphTextItem()
    .setTitle('Другие важные правила?')
    .setHelpText('Необязательно. Тихий час, нельзя вечеринки и т.п.')
    .setRequired(false);

  // ─── Раздел 8. Когда звать оператора ────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle('8. Когда подключать живого человека')
    .setHelpText('Бот сам зовёт оператора в этих случаях — отметьте свои.');

  form.addCheckboxItem()
    .setTitle('В каких ситуациях бот должен сразу звать оператора?')
    .setChoiceValues([
      'Жалоба или конфликт',
      'Поломка / что-то не работает в квартире',
      'Вопрос про возврат денег',
      'Гость прямо просит живого человека',
      'Нестандартная просьба, которой нет в правилах',
    ])
    .showOtherOption(true)
    .setRequired(false);

  Logger.log('=== ФОРМА 1 (Бизнес-правила) ===');
  Logger.log('EDIT URL: ' + form.getEditUrl());
  Logger.log('LIVE URL: ' + form.getPublishedUrl());
}

// ════════════════════════════════════════════════════════════════════════════
// ФОРМА 2 — КАРТОЧКА ОБЪЕКТА (на каждую квартиру → поля Property)
// ════════════════════════════════════════════════════════════════════════════
function createPropertyForm() {
  const form = FormApp.create('AvitoBot — карточка объекта')
    .setDescription(
      'Заполните на КАЖДУЮ квартиру отдельно. Данные про эту конкретную квартиру: ' +
      'адрес, код двери, wifi. Чувствительные данные бот выдаёт гостю только после оплаты и заезда.'
    )
    .setProgressBar(true)
    .setCollectEmail(false);

  form.addTextItem()
    .setTitle('Название объекта')
    .setHelpText('Как вы называете эту квартиру между собой. Например: «Студия на Ленина».')
    .setRequired(true);

  form.addTextItem()
    .setTitle('ID объявления на Авито (если знаете)')
    .setHelpText('Необязательно. Поможет привязать бота к нужному объявлению.')
    .setRequired(false);

  form.addTextItem()
    .setTitle('Точный адрес объекта')
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Короткое описание объекта для гостя')
    .setRequired(true);

  // ─── Особые условия именно этой квартиры (переопределения) ───────────────────
  form.addSectionHeaderItem()
    .setTitle('Особенности этой квартиры')
    .setHelpText('Заполняйте, только если у ЭТОЙ квартиры что-то отличается от общих правил.');

  form.addParagraphTextItem()
    .setTitle('Особые правила или условия этого объекта')
    .setHelpText('Необязательно. Например: другое время заезда, можно с животными, особый депозит.')
    .setRequired(false);

  form.addParagraphTextItem()
    .setTitle('Парковка, что рядом, особенности квартиры')
    .setHelpText('Парковка (есть/платная/где), метро/магазины рядом, вид, этаж, техника.')
    .setRequired(false);

  // ─── Чувствительные данные (→ защищённые поля Property) ──────────────────────
  form.addSectionHeaderItem()
    .setTitle('Данные для заселения')
    .setHelpText(
      'Бот выдаёт это гостю ТОЛЬКО после оплаты и заезда. ' +
      'Можно оставить пустым и вписать позже.'
    );

  form.addTextItem()
    .setTitle('Код от двери / подъезда')
    .setRequired(false);

  form.addTextItem()
    .setTitle('Название WiFi-сети')
    .setRequired(false);

  form.addTextItem()
    .setTitle('Пароль от WiFi')
    .setRequired(false);

  form.addParagraphTextItem()
    .setTitle('Инструкция по заселению')
    .setHelpText('Как попасть в квартиру, где ключи, нюансы входа.')
    .setRequired(false);

  Logger.log('=== ФОРМА 2 (Карточка объекта) ===');
  Logger.log('EDIT URL: ' + form.getEditUrl());
  Logger.log('LIVE URL: ' + form.getPublishedUrl());
}
