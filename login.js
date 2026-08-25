const form = document.querySelector('#loginForm');
const button = document.querySelector('#loginButton');
const message = document.querySelector('#loginMessage');

form?.addEventListener('submit', async event => {
  event.preventDefault();
  message.textContent = '';
  button.disabled = true;
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      credentials: 'same-origin',
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 429 ? 'Muitas tentativas. Aguarde alguns minutos.' : 'Usuário ou senha inválidos.');
    window.location.replace('/');
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
  }
});
