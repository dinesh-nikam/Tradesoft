import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { problemMessage, type Api } from '../../lib/api.ts';

interface User {
  id: string;
  email: string;
  displayName: string;
  status: string;
  mfaEnabled: boolean;
}

interface Role {
  code: string;
  name: string;
}

/**
 * User administration (05 §11.3): list, invite when the principal holds user:write, and replace a
 * user's roles when it also holds role:read.
 */
export function Users({
  api,
  canWrite,
  canAssignRoles,
}: {
  api: Api;
  canWrite: boolean;
  canAssignRoles: boolean;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [editing, setEditing] = useState<(User & { roles: string[] }) | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setUsers((await api.request<{ data: User[] }>('GET', '/users')).data);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canAssignRoles) return;
    void (async () => {
      const { data } = await api.request<{ data: Role[] }>('GET', '/roles');
      // 00 §4.2: INGEST_SERVICE belongs to API keys only, so it is never offered for a person.
      setRoles(data.filter((r) => r.code !== 'INGEST_SERVICE'));
    })();
  }, [api, canAssignRoles]);

  const invite = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await api.request('POST', '/users', {
        email: String(form.get('email')),
        displayName: String(form.get('displayName')),
      });
      setMessage('Invitation sent.');
      await load();
    } catch (err) {
      setMessage(problemMessage(err, 'The invitation failed'));
    }
  };

  const edit = async (id: string) => {
    try {
      setEditing(await api.request<User & { roles: string[] }>('GET', `/users/${id}`));
      setMessage(null);
    } catch (err) {
      setMessage(problemMessage(err, 'The user could not be loaded'));
    }
  };

  const saveRoles = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editing) return;
    const roleCodes = new FormData(e.currentTarget).getAll('roleCodes').map(String);
    try {
      await api.request('PUT', `/users/${editing.id}/roles`, { roleCodes });
      setMessage(`Roles saved for ${editing.displayName}.`);
      setEditing(null);
    } catch (err) {
      setMessage(problemMessage(err, 'The roles could not be saved'));
    }
  };

  return (
    <section>
      <h2>Users</h2>
      {message && <p role="status">{message}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Status</th>
            <th>MFA</th>
            {canAssignRoles && <th>Roles</th>}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.displayName}</td>
              <td>{u.email}</td>
              <td>{u.status}</td>
              <td>{u.mfaEnabled ? 'Yes' : 'No'}</td>
              {canAssignRoles && (
                <td>
                  <button type="button" onClick={() => void edit(u.id)}>
                    Edit roles
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <form key={editing.id} onSubmit={(e) => void saveRoles(e)}>
          <fieldset>
            <legend>Roles for {editing.displayName}</legend>
            {roles.map((r) => (
              <label key={r.code} style={{ display: 'block' }}>
                <input
                  type="checkbox"
                  name="roleCodes"
                  value={r.code}
                  defaultChecked={editing.roles.includes(r.code)}
                />{' '}
                {r.name}
              </label>
            ))}
          </fieldset>
          <button type="submit">Save roles</button>{' '}
          <button type="button" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </form>
      )}
      {canWrite && (
        <form onSubmit={(e) => void invite(e)}>
          <h3>Invite a user</h3>
          <label>
            Name <input name="displayName" required />
          </label>
          <label>
            Email <input name="email" type="email" required />
          </label>
          <button type="submit">Send invitation</button>
        </form>
      )}
    </section>
  );
}
