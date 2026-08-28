# Bonus Control — Frota Fixa

Painel operacional para acompanhamento mensal e quinzenal da bonificação de dispatchers.

## Períodos

- `1ª Quinzena`: dias 1 a 15; a Frota Fixa usa 13 dias planejados.
- `2ª Quinzena`: dias 16 ao último dia do mês; a Frota Fixa usa 13 dias planejados.
- `Mensal`: mês completo; a Frota Fixa preserva a regra original de 26 dias planejados.

O Spot usa a quantidade real de dias do período selecionado para calcular a média diária.

## Regra implementada

1. Cada linha representa uma rota em uma data. Portanto, se um motorista roda mais de uma vez no dia, cada rota continua sendo avaliada individualmente.
2. A DS não é mais lida do DDS: ela vem da coluna L `Entregas com sucesso` do Mercado Livre, cruzada por motorista e data da rota.
3. A linha entra no universo de Frota Fixa quando `modalidade` é `FROTA FIXA` ou `reserva_ff` é verdadeiro.
4. Linhas de ambulância são desconsideradas quando `Cluster = ROTA`, mesmo que estejam marcadas como Frota Fixa ou Reserva FF.
5. O portão de DS é `DS médio por rota >= 92%`.
6. A utilização mensal é calculada como `rotas_utilizadas / rotas_FF_elegíveis`.
7. A maior faixa atingida define o pagamento: 100% = R$ 1.000; 95% = R$ 700; 90% = R$ 350. Abaixo de 90% ou sem passar no DS = R$ 0.

## Reserva FF

Reserva FF não é inferida por observação ou pelo nome do veículo. O workbook analítico possui a aba `Cadastro Reserva FF`, que deve ser preenchida com placa/identificador, vigência e status ativo. A regra deve considerar uma rota como Reserva FF somente quando a placa estiver cadastrada e ativa na data da rota.

## Importação CSV

O botão **Importar CSV** aceita estas colunas, nesta ordem ou com cabeçalho equivalente:

```csv
data,base,modalidade,ds_pct,ambulancia,reserva_ff,rota_utilizada
2026-08-01,Cajamar,FROTA FIXA,97.2,nao,nao,sim
2026-08-01,Cajamar,FROTA FIXA,96.4,nao,sim,sim
2026-08-01,Cajamar,FROTA FIXA,88.0,sim,nao,sim
```

O agrupamento mensal por base é recalculado no navegador. Para produção, o próximo passo é substituir o CSV local por uma API/banco de dados e registrar o fechamento do mês com auditoria.

## Executar

Abra `index.html` no navegador. Não há dependências de build nesta primeira versão.

## Segurança e produção

O painel exige autenticação antes de servir o dashboard e os dados operacionais. Há três
papéis configurados exclusivamente por variáveis protegidas do Railway:

- Gerência (`AUTH_USERNAME`): acesso completo.
- Coordenação (`AUTH_COORDINATION_USERNAME`): Dashboard, Rotas, Bases e Comparativo; pode anexar NF.
- Dispatcher (`AUTH_DISPATCHER_USERNAME`): as mesmas quatro telas, somente para leitura.

Cada usuário usa seu próprio `*_PASSWORD_HASH`; a senha nunca fica no frontend. As sessões usam
cookie `HttpOnly`, `Secure` em produção, `SameSite=Strict`, expiração e invalidação no
logout. Várias sessões do mesmo usuário compartilhado podem coexistir. As APIs validam o
papel no backend, portanto esconder botões não é a proteção.

Gere cada hash sem gravar a senha no repositório:

```bash
npm run auth:hash -- "senha-temporaria-com-12-ou-mais-caracteres"
```

Em produção, mantenha `ADMIN_MUTATIONS_ENABLED=true` e `ADMIN_READ_ENABLED=true` somente
com o login configurado. `ADMIN_IP_ALLOWLIST` é opcional: vazio ou `*` permite gerentes
autenticados de qualquer rede; quando preenchido, restringe por IP. `APP_ORIGIN` deve
conter somente a origem oficial do painel. Sem login válido, importações, equipes, notas
fiscais e arquivamentos permanecem bloqueados.

O servidor agora limita payloads e requisições, valida linhas e arquivos, usa consultas
parametrizadas, registra auditoria, torna importações idempotentes, arquiva dados em vez
de apagá-los fisicamente e não publica arquivos internos do projeto. O valor da nota
fiscal é recalculado no servidor a partir das rotas, Mercado Livre, LOGICA FF, cadastro
FF/Locadora e equipe persistidos; o valor enviado pelo navegador é apenas conferência.

As variáveis necessárias estão exemplificadas em `.env.example`. Nunca commit credenciais
ou arquivos `.env`; em Railway, use as variáveis protegidas do serviço e um usuário de
banco com permissões somente nas tabelas da aplicação. A aplicação cria a tabela de
sessões na migração inicial para manter compatibilidade com o ambiente atual; depois de
aplicar e validar a migração, retire permissões DDL do usuário da aplicação.
