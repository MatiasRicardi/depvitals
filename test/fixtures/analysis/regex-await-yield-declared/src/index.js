export async function load() {
  return await /require('fake')/;
}

export function* emit() {
  yield /require('fake')/;
}
