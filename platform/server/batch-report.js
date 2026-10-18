import ExcelJS from 'exceljs';

const COLORS = { accent: 'FFA31551', ink: 'FF29252F', muted: 'FF756B7C', tint: 'FFF8EFF3', line: 'FFE8E2EB' };
const labels = { queued: 'В очереди', processing: 'Проверяется', failed: 'Ошибка', done: 'Проверено' };
const verdicts = { violation: 'Признаки возможного нарушения', no_violation: 'Нарушение не обнаружено', review_required: 'Требуется ручная проверка' };
// Explicit string cell values never become formulas or external hyperlinks.
const text = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 32767);
const eventList = job => job?.verdict === 'review_required' ? job.observed_events || [] : job?.violations || [];

function setupSheet(book, name, columns, title, subtitle, note) {
  const sheet = book.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 6 }],
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:6' },
  });
  sheet.columns = columns.map(([label, width]) => ({ width }));
  for (let row = 1; row <= 4; row++) sheet.mergeCells(row, 1, row, columns.length);
  sheet.getCell('A1').value = title;
  sheet.getCell('A1').font = { name: 'Calibri', size: 20, bold: true, color: { argb: COLORS.accent } };
  sheet.getRow(1).height = 32;
  for (const [row, value] of [[2, subtitle], [3, note], [4, 'Источник: сохранённые результаты сервера модели. Выводы модели требуют проверки человеком.']]) {
    sheet.getCell(row, 1).value = text(value);
    sheet.getCell(row, 1).font = { name: 'Calibri', size: 11, color: { argb: COLORS.muted } };
    sheet.getCell(row, 1).alignment = { vertical: 'middle', wrapText: true };
    sheet.getRow(row).height = 29;
  }
  const header = sheet.getRow(6);
  header.values = columns.map(([label]) => label);
  header.height = 32;
  header.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.accent } };
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  return sheet;
}

function addRow(sheet, values) {
  const row = sheet.addRow(values.map(value => typeof value === 'number' || value instanceof Date ? value : text(value)));
  let lines = 2;
  row.eachCell((cell, col) => {
    cell.font = { name: 'Calibri', size: 11, color: { argb: COLORS.ink } };
    cell.alignment = { vertical: 'top', wrapText: true };
    cell.border = { bottom: { style: 'hair', color: { argb: COLORS.line } } };
    if (row.number % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.tint } };
    const width = Math.max(8, sheet.getColumn(col).width - 2);
    lines = Math.max(lines, String(cell.value ?? '').split('\n').reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / width)), 0));
  });
  row.height = Math.min(409, lines * 15 + 10);
  return row;
}

export async function createBatchReport(batch) {
  const items = batch.items || [], book = new ExcelJS.Workbook(), now = new Date();
  book.creator = 'Vision Forte'; book.created = now; book.modified = now;
  book.title = 'Результаты проверки архива'; book.subject = text(batch.original_name);
  const done = items.filter(item => item.status === 'done').length;
  const failed = items.filter(item => item.status === 'failed').length;
  const pending = items.length - done - failed;
  const note = `${pending ? 'ПРОМЕЖУТОЧНЫЙ ОТЧЁТ' : 'ОБРАБОТКА ЗАВЕРШЕНА'} · Всего: ${items.length} · Проверено: ${done} · Ошибок: ${failed} · Ожидают результата: ${pending}`;
  const subtitle = `Архив: ${batch.original_name} · Сформировано: ${now.toISOString()} (UTC)`;
  const videos = setupSheet(book, 'Видеозаписи', [
    ['№', 6], ['Видеозапись', 32], ['Статус обработки', 22], ['Ответ модели', 34], ['Комментарий модели', 75],
    ['Событий', 12], ['Ограничения проверки', 60], ['Ошибка', 52], ['Модель / версия', 36], ['ID видеозаписи', 39],
  ], 'Vision Forte · Проверка видеозаписей', subtitle, note);
  const events = setupSheet(book, 'События', [
    ['№ видео', 10], ['Видеозапись', 32], ['Ответ модели', 34], ['Тип события', 30], ['Таймкод, с', 15],
    ['Начало, с', 15], ['Конец, с', 15], ['Описание и причина', 85], ['Нормативные основания', 65],
  ], 'Vision Forte · События по видеозаписям', subtitle, note);
  items.forEach((item, index) => {
    const job = item.job, completed = item.status === 'done' && job?.status === 'done';
    const currentEvents = completed ? eventList(job) : [];
    const verdict = completed ? verdicts[job.verdict] || 'Результат недоступен' : 'Заключение не сформировано';
    const error = item.error || job?.error;
    const summary = completed ? job.summary || currentEvents.map(event => event.description).join('\n\n') || (job.verdict === 'no_violation' ? 'Модель не выявила признаков возможных нарушений.' : 'Проверьте исходную запись вручную.') : '';
    addRow(videos, [index + 1, item.original_name, labels[item.status] || item.status, verdict, summary,
      completed ? currentEvents.length : '', (job?.warnings || []).join('\n'), error ? `${error.code || ''}: ${error.message || ''}` : '',
      [job?.model?.name, job?.model?.version].filter(Boolean).join(' · '), item.video_id || '']);
    currentEvents.forEach(event => {
      const row = addRow(events, [index + 1, item.original_name, verdict, event.type, event.timecode_sec ?? '', event.start_sec ?? '', event.end_sec ?? '',
        event.description, (event.rule_refs || []).map(ref => [ref.title, ref.section, ref.url, ref.verified ? 'Проверено' : 'Не подтверждено'].filter(Boolean).join(' · ')).join('\n')]);
      for (const col of [5, 6, 7]) row.getCell(col).numFmt = '0.00';
    });
  });
  if (events.rowCount === 6) addRow(events, ['', '', '', '', '', '', '', 'Событий для выгрузки пока нет. Статус каждой записи приведён на листе «Видеозаписи».', '']);
  for (const sheet of [videos, events]) sheet.autoFilter = { from: { row: 6, column: 1 }, to: { row: sheet.rowCount, column: sheet.columnCount } };
  return Buffer.from(await book.xlsx.writeBuffer());
}
