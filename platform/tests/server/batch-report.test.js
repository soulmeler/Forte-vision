import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createBatchReport } from '../../server/batch-report.js';

test('Excel report preserves per-video outcomes, comments, timestamps and unfinished status', async () => {
  const batch = { id: 'report-fixture', original_name: 'Операции.zip', items: [
    { original_name: 'Норма.mov', video_id: 'a', status: 'done', job: { status: 'done', verdict: 'no_violation', summary: 'Кассир завершил операцию.', violations: [], model: { name: 'Vision', version: 'v1' } } },
    { original_name: 'Событие.mov', video_id: 'b', status: 'done', job: { status: 'done', verdict: 'violation', violations: [{ type: 'Передача', timecode_sec: 12.5, description: 'Передан предмет.', rule_refs: [] }] } },
    { original_name: 'Неясно.mov', video_id: 'c', status: 'done', job: { status: 'done', verdict: 'review_required', violations: [], observed_events: [{ type: 'Движение', timecode_sec: 5, start_sec: 4, end_sec: 6, description: 'Данных недостаточно.' }], warnings: ['Закрыт обзор.'] } },
    { original_name: 'Ошибка.mov', status: 'failed', error: { code: 'INVALID_VIDEO', message: 'Не удалось прочитать видео.' } },
    { original_name: 'Очередь.mov', video_id: 'e', status: 'queued' },
  ] };
  const bytes = await createBatchReport(batch), book = new ExcelJS.Workbook();
  assert.equal(bytes.subarray(0, 2).toString(), 'PK'); await book.xlsx.load(bytes);
  const videos = book.getWorksheet('Видеозаписи'), events = book.getWorksheet('События');
  assert.equal(videos.rowCount, 11); assert.match(videos.getCell('A3').value, /ПРОМЕЖУТОЧНЫЙ.*Всего: 5.*Проверено: 3.*Ошибок: 1.*Ожидают результата: 1/);
  assert.equal(videos.getCell('D7').value, 'Нарушение не обнаружено'); assert.equal(videos.getCell('E7').value, 'Кассир завершил операцию.');
  assert.equal(videos.getCell('D9').value, 'Требуется ручная проверка'); assert.equal(videos.getCell('G9').value, 'Закрыт обзор.');
  for (const row of [10, 11]) assert.equal(videos.getCell(`D${row}`).value, 'Заключение не сформировано');
  assert.match(videos.getCell('H10').value, /INVALID_VIDEO/);
  assert.equal(events.rowCount, 8); assert.equal(events.getCell('E7').value, 12.5); assert.equal(events.getCell('F8').value, 4);
  assert.equal(videos.views[0].ySplit, 6); assert.ok(videos.autoFilter);
});

test('untrusted names and model text remain literal Excel strings, never executable formulas', async () => {
  const value = '=HYPERLINK("https://example.invalid","click")';
  const bytes = await createBatchReport({ original_name: value, items: [{ original_name: value, status: 'done', job: { status: 'done', verdict: 'no_violation', summary: value, violations: [] } }] });
  const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes);
  const sheet = book.getWorksheet('Видеозаписи');
  assert.equal(sheet.getCell('B7').value, value); assert.equal(sheet.getCell('E7').value, value);
  assert.equal(sheet.getCell('B7').type, ExcelJS.ValueType.String); assert.equal(sheet.getCell('E7').formula, undefined);
  assert.match(sheet.getCell('A3').value, /ОБРАБОТКА ЗАВЕРШЕНА/);
});
