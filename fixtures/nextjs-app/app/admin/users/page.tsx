async function createUser(formData: FormData) {
  'use server';
  const name = formData.get('name');
  const email = formData.get('email');
  console.log({ name, email });
}

export default function AdminUsersPage() {
  return (
    <form action={createUser}>
      <input name="name" type="text" />
      <input name="email" type="email" />
      <button type="submit">Create</button>
    </form>
  );
}
