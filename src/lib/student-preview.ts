type Row = { id: string; [key: string]: any };
type CourseData = {
  now: string; materials: Row[]; materialFiles: Row[]; files: Row[];
  assignments: Row[]; sessions: Row[];
};

export const studentViewRequested = (search: string) => new URLSearchParams(search).get('view') === 'student';
export const courseViewUrl = (module: number | 'project', student: boolean) => `?module=${module}${student ? '&view=student' : ''}`;

// Предпросмотр не меняет роль и не использует данные конкретного участника.
export function studentPreviewData<T extends CourseData>(data: T) {
  const now = new Date(data.now).getTime();
  const materials: Row[] = data.materials.filter(m => m.published && m.audience === 'participant').map(m => {
    const open = !m.opens_at || new Date(m.opens_at).getTime() <= now;
    return open ? { ...m, open: true } : {
      id: m.id, module: m.module, position: m.position, title: m.title,
      audience: m.audience, published: true, opens_at: m.opens_at, open: false,
    };
  });
  const openIds = new Set(materials.filter(m => m.open).map(m => m.id));
  const materialFiles = data.materialFiles.filter(f => openIds.has(f.material_id));
  const fileIds = new Set(materialFiles.map(f => f.file_id));
  const preview = {
    materials, materialFiles, files: data.files.filter(f => fileIds.has(f.id)),
    assignments: data.assignments.filter(a => a.published && (!a.opens_at || new Date(a.opens_at).getTime() <= now)),
    sessions: data.sessions.map(s => s.recording_published ? s : { ...s, recording_url: null }),
    works: [], drafts: [], submissions: [], reviews: [], reviewDrafts: [], people: [],
    project: null, projects: [], packageItems: [], questions: [], answers: [], progress: [],
    presentations: [], reviewers: [], notifications: [], feedback: [], earlyCommencementConsents: [], mail: null,
  };
  return { ...data, ...preview } as Omit<T, keyof typeof preview> & typeof preview;
}
