-- Опубликованное задание ещё не принимало работ. Заменяем старую форму
-- с восемью вариантами на одну область сдачи по согласованному слайду 35.
update lms.assignments a
set spec = '{"title":"2.2 · Your concept and AI experiments","parts":[{"id":"homework","title":"Submit your homework","required":true,"allowLinkOnly":true,"hint":"Paste a full https:// link to your document or attach a file. Include your updated pitch, one visual AI experiment, one gameplay AI experiment, the prompts you used, what worked or failed, and what you kept or changed and why. A complete slot is not required."}]}'::jsonb,
    revision = a.revision + 1
where a.module = 2
  and a.spec->>'title' = '2.2 · Develop a visual direction'
  and a.published = false
  and not exists (select 1 from lms.works w where w.assignment_id = a.id);
