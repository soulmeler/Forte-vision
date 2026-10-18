import React from 'react';
import { Flag } from 'lucide-react';

export const reviewLabels = { violation: 'Нарушение', safe: 'Безопасно', model_error: 'Ошибка модели' };
export default function ReviewFlag({ review }) {
  if (!reviewLabels[review?.decision]) return null;
  return <span className={`review-flag review-flag-${review.decision}`} title={`Решение сотрудника · ${new Date(review.reviewed_at).toLocaleString('ru-RU')}`}><Flag size={15}/>{reviewLabels[review.decision]}</span>;
}
