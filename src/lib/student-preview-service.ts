import { AppError, uuid } from './contract';
import { transaction } from './db';

// Только администратор может читать кабинет выбранного участника.
// Сессия и права администратора не меняются; запись через этот режим запрещена в HTTP.
export async function studentPreviewTarget(administratorId: string, requested?: string | null) {
  return transaction(administratorId, async tx => {
    const [admin] = await tx`select lms.is_admin() as allowed`;
    if (!admin.allowed) throw new AppError('forbidden', 'Student preview is available to administrators only.', 403);
    const participants = await tx`select id,name from lms.profiles where role='participant'
      and activated_at is not null and revoked_at is null and access_ends_at>now() order by name,id`;
    const participantId = requested ? uuid.parse(requested) : participants[0]?.id;
    if (!participantId || !participants.some(p => p.id === participantId)) {
      throw new AppError('preview_unavailable', 'Choose a participant with active course access.', 404);
    }
    return { participantId: participantId as string, administratorId, participants };
  });
}
