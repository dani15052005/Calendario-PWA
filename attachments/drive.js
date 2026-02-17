(() => {
  const root = (window.CalendarModules = window.CalendarModules || {});
  const drive = (root.attachmentsDrive = root.attachmentsDrive || {});

  function resolveDriveFileId(att) {
    return String(att?.gdriveId || att?.drive_file_id || '').trim();
  }

  function ensureDriveFileId(att) {
    const id = resolveDriveFileId(att);
    if (!id) throw new Error('Adjunto sin drive_file_id');
    return id;
  }

  function normalizeAttachmentForPersistence(att, eventId, ensureUuidId) {
    const driveId = ensureDriveFileId(att);
    return {
      ...att,
      id: ensureUuidId(att?.id),
      eventId,
      event_id: eventId,
      name: att?.name || att?.file_name || 'archivo',
      file_name: att?.file_name || att?.name || 'archivo',
      type: att?.type || att?.file_type || 'application/octet-stream',
      file_type: att?.file_type || att?.type || 'application/octet-stream',
      gdriveId: driveId,
      drive_file_id: driveId
    };
  }

  drive.resolveDriveFileId = resolveDriveFileId;
  drive.ensureDriveFileId = ensureDriveFileId;
  drive.normalizeAttachmentForPersistence = normalizeAttachmentForPersistence;
})();

