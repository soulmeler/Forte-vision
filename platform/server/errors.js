export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message); Object.assign(this, { status, code, details });
  }
}
export const missing = () => new ApiError(404, 'NOT_FOUND', 'Запись не найдена.');
export const modelNotReady = () => new ApiError(503, 'MODEL_NOT_READY', 'Обученная модель пока не подключена или не готова. Видео можно загрузить и просмотреть.');
