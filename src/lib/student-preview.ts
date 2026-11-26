export const studentViewRequested = (search: string) => new URLSearchParams(search).get('view') === 'student';
export const expertViewRequested = (search: string) => new URLSearchParams(search).get('view') === 'expert';
export const previewRequested = (search: string) => studentViewRequested(search) || expertViewRequested(search);

export const courseViewUrl = (module: number | 'project', student: boolean | 'expert', participant?: string | null) => {
  const params = new URLSearchParams({ module: String(module) });
  if (student) {
    const view = student === 'expert' ? 'expert' : 'student';
    params.set('view', view);
    if (participant) params.set(view, participant);
  }
  return `?${params}`;
};

// Ссылки сохраняют выбранного участника или эксперта; API и файлы — серверный режим только для чтения.
export function studentPreviewUrl(path: string, search: string, api = false) {
  if (!previewRequested(search)) return path;
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  const url = new URL(path, 'https://preview.invalid');
  const page = new URLSearchParams(search);
  const view = expertViewRequested(search) ? 'expert' : 'student';
  url.searchParams.set(api ? 'preview' : 'view', view);
  const participant = page.get(view);
  if (participant) url.searchParams.set(view, participant);
  return `${url.pathname}${url.search}${url.hash}`;
}
