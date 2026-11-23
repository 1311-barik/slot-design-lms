export const studentViewRequested = (search: string) => new URLSearchParams(search).get('view') === 'student';

export const courseViewUrl = (module: number | 'project', student: boolean, participant?: string | null) => {
  const params = new URLSearchParams({ module: String(module) });
  if (student) {
    params.set('view', 'student');
    if (participant) params.set('student', participant);
  }
  return `?${params}`;
};

// Ссылки на модуль сохраняют выбранного участника, API и файлы — серверный режим только для чтения.
export function studentPreviewUrl(path: string, search: string, api = false) {
  if (!studentViewRequested(search)) return path;
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  const url = new URL(path, 'https://preview.invalid');
  const page = new URLSearchParams(search);
  url.searchParams.set(api ? 'preview' : 'view', 'student');
  const participant = page.get('student');
  if (participant) url.searchParams.set('student', participant);
  return `${url.pathname}${url.search}${url.hash}`;
}
