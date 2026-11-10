import { updatePersonAction } from "@/app/actions/admin";
import { AdminTabs, Field, Notice, SubmitButton } from "@/components/admin/parts";
import { Avatar } from "@/components/ui/avatar";
import { Empty, Page, PageHeader } from "@/components/ui/bits";
import { listPeople } from "@/lib/api-client";
import { titleAndOrg } from "@/lib/format";
import { isStoredPhoto } from "@/lib/photo";

export const dynamic = "force-dynamic";

export default async function AdminSpeakersPage({ searchParams }: PageProps<"/admin/speakers">) {
  const { error, done } = await searchParams;
  const people = await listPeople();
  return (
    <Page narrow>
      <PageHeader title="Admin" lead="Speakers are created when a schedule names them or a stream introduces them. Correct a name, fill in who they are, and give them a photo here." />
      <AdminTabs current="speakers" />
      <Notice error={error} done={done} />
      {people.length === 0 && <Empty>No speakers yet.</Empty>}
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {people.map(({ person }) => (
          <li key={person.id}>
            <details className="group px-5 py-3">
              <summary className="flex cursor-pointer items-center gap-3">
                <Avatar name={person.name} photoUrl={person.photo_url} />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold group-open:text-accent">{person.name}</span>
                  <span className="block truncate text-[13px] text-ink-soft">{titleAndOrg(person) ?? "No title or organisation yet"}</span>
                </span>
                <span className="text-[13px] text-ink-faint group-open:hidden">Edit</span>
              </summary>
              <form action={updatePersonAction} className="mt-4 grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="id" value={person.id} />
                <Field label="Name">
                  <input name="name" required defaultValue={person.name} className="field" />
                </Field>
                <Field label="Organisation">
                  <input name="org" defaultValue={person.org ?? ""} className="field" />
                </Field>
                <Field label="Title">
                  <input name="title" defaultValue={person.title ?? ""} className="field" />
                </Field>
                <Field label={isStoredPhoto(person.photo_url) ? "Photo link (a photo is stored; paste a link to replace it)" : "Photo link"}>
                  <input name="photo_url" type="url" defaultValue={isStoredPhoto(person.photo_url) ? "" : (person.photo_url ?? "")} placeholder="https://..." className="field" />
                </Field>
                {isStoredPhoto(person.photo_url) && <input type="hidden" name="photo_stored" value={person.photo_url ?? ""} />}
                <div className="sm:col-span-2">
                  <SubmitButton working="Saving">Save speaker</SubmitButton>
                </div>
              </form>
            </details>
          </li>
        ))}
      </ul>
    </Page>
  );
}
