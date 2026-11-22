This changes the curriculum in a useful way: **Keycloak should become your practical laboratory, not a distraction from your research direction.** Your work on Verimi brokering and passkey enrollment is directly relevant to identity federation, authentication assurance, credential lifecycle, and the boundary between authentication and authorization.

I would not replace the original curriculum with a Keycloak-only learning plan. Instead, I’d integrate your work as one continuous case study. That way, each week you learn a concept, apply it to the portal, and record the questions that could eventually become research questions.

There is also an important distinction in your flow: **the first login is federated authentication through Verimi; passkey enrollment is a separate credential-registration step; subsequent logins use the passkey through Keycloak.** Keeping those three stages conceptually separate will help you understand both the architecture and its security properties.

## 1. First, refine the architecture you are building

Your proposed flow is sound at a high level. I would model it as two related but distinct journeys.

### A. First login: Verimi → Keycloak → portal

```text
Browser             Portal              Keycloak             Verimi
   |                   |                    |                    |
   |--- Open portal -->|                    |                    |
   |--- Click Login -->|                    |                    |
   |                   |-- OIDC redirect -->|                    |
   |                   |                    |-- OIDC redirect -->|
   |                   |                    |                    |
   |<-------------------- Verimi login page ---------------------|
   |--- Enter credentials -------------------------------------->|
   |                   |                    |<-- Auth response --|
   |                   |                    |                    |
   |                   |<-- OIDC callback --|                    |
   |<-- Portal page ---|                    |                    |
   |                   |                    |                    |
```

The important point: **Keycloak is acting as an identity broker.** Verimi authenticates the user; Keycloak consumes the result, resolves or creates the corresponding Keycloak user, and issues tokens to your portal. Your portal should normally know Keycloak as its OIDC provider—not need to integrate directly with Verimi.

Keycloak's documentation describes this OIDC identity-brokering model. [Keycloak](https://www.keycloak.org/docs/latest/server_admin/?utm_source=chatgpt.com)

A small but important UX correction: with a normal OIDC browser flow, the browser is redirected to Keycloak. You can make that transition nearly invisible by configuring automatic IdP redirection, a branded Keycloak theme, and a suitable login hostname. But the browser's address bar may briefly show the Keycloak hostname. Don't try to hide the flow in an iframe; use normal top-level redirects.

### B. Passkey enrollment: portal → Keycloak → portal

After the user has logged in through Verimi:

```text
Browser             Portal              Keycloak
   |                   |                    |
   |-- Click "Create passkey" ------------>|
   |                   |-- OIDC request --->|
   |                   |  + passkey action  |
   |                   |                    |
   |<----------- Keycloak passkey screen ---|
   |                   |                    |
   |-- Create passkey using device/security key
   |                   |                    |
   |                   |<-- OIDC callback --|
   |<-- Portal page ---|                    |
```

The key feature to investigate here is **Application-Initiated Actions (AIA)**.

Keycloak supports an OIDC login request containing a `kc_action` parameter. This allows your application to ask Keycloak to perform a particular action—even when the user already has an active Keycloak SSO session. Keycloak specifically documents these actions for WebAuthn registration, including:

- `kc_action=webauthn-register`
- `kc_action=webauthn-register-passwordless`

For your use case, the second is the relevant one: it registers a passwordless WebAuthn credential intended for passkey login. The action must be enabled in Keycloak. [Keycloak](https://www.keycloak.org/docs/26.7.5/server_admin/index.html?utm_source=chatgpt.com)

Conceptually, your portal's button initiates another OIDC authorization request, this time asking Keycloak to perform the passkey-registration action. You should use the normal OIDC authorization-code flow, with the usual state, nonce and PKCE protections—not construct an arbitrary redirect to an unprotected Keycloak page.

**One security issue deserves special attention:** being logged in is not automatically sufficient proof that it is safe to add a new authentication credential. Someone with a stolen session could otherwise register their own passkey and potentially take over the account. Require sufficiently recent authentication, and consider whether your Verimi authentication provides the assurance level your application needs. Keycloak documents re-authentication rules for AIA and a configurable maximum authentication age for passkey registration. [Keycloak](https://www.keycloak.org/docs/latest/server_admin/?utm_source=chatgpt.com)

Also, do not assume that a successful redirect to Keycloak proves that enrollment succeeded. Handle the action's return status and verify the resulting credential state where appropriate. Keycloak explicitly warns that requesting an action does not guarantee that the user completed it. [Keycloak](https://www.keycloak.org/docs/26.1.5/server_admin/?utm_source=chatgpt.com)

A passkey can be created on a device using its built-in authenticator, or with an external security key. A QR-code handoff is one possible cross-device browser experience; it is not something your portal should implement as its own credential protocol. The browser and authenticator handle the WebAuthn ceremony.

### C. Subsequent login: passkey → Keycloak → portal

```text
Browser             Portal              Keycloak
   |                   |                    |
   |--- Open portal -->|                    |
   |--- Click Login -->|                    |
   |                   |-- OIDC redirect -->|
   |<----------- Keycloak login screen ----|
   |--- Choose/use passkey ---------------->|
   |                   |                    |
   |                   |<-- OIDC callback --|
   |<-- Portal page ---|                    |
```

Keycloak supports passwordless WebAuthn authentication and passkey-specific policy settings. Make sure you configure the passwordless WebAuthn policy and the corresponding authentication flow—not just ordinary WebAuthn as a second factor. [GitHub](https://github.com/keycloak/keycloak/blob/main/docs/documentation/server_admin/topics/authentication/passkeys.adoc?utm_source=chatgpt.com)

---

## 2. How the Keycloak book fits in

I would definitely include it. In fact, it becomes your main practical reference for the first part of the curriculum.

I recommend using the **second edition** of *Keycloak – Identity and Access Management for Modern Applications*, by Stian Thorgersen and Pedro Igor Silva, published in July 2023. It is based on Keycloak 22, so it is useful for understanding the product, but you should use the current Keycloak documentation for version-specific configuration and newer features. [O'Reilly Media](https://www.oreilly.com/library/view/keycloak-identity/9781804616444/?utm_source=chatgpt.com)

You don't need to read it cover to cover. Prioritize these topics:

| Book topic | Why it matters for your project |
|---|---|
| Getting Started with Keycloak | Realms, users, clients, account console |
| Brief Introduction to Standards | OAuth 2.0, OIDC, JWT |
| Authenticating Users with OIDC | Understand the portal's login flow |
| Securing Different Application Types | Understand how your portal integrates |
| Integrating Applications with Keycloak | Client configuration and integration |
| Managing Users | Federated users and identity linking |
| Authenticating Users | Authentication flows, WebAuthn |
| Managing Tokens and Sessions | SSO, sessions, token lifetimes |
| Securing Keycloak and Applications | Production security |

The second edition's contents include WebAuthn registration and authentication, authentication flows, tokens, sessions and application security. [O'Reilly Media](https://www.oreilly.com/library/view/keycloak-identity/9781804616444/?utm_source=chatgpt.com)

**My recommendation:** read the relevant book chapter first, implement the corresponding feature, and then consult the current Keycloak documentation when you encounter a version-specific detail. Avoid spending hours reading every Keycloak feature that isn't relevant to your project.

---

## 3. How I would adjust your 12-week curriculum

I would preserve the original research direction—identity and authorization engineering in distributed systems—but make your real-world Keycloak integration the running project.

The revised schedule below assumes around 7–8 hours per week.

| Weeks | Study focus | Practical work on your project | Research perspective |
|---|---|---|---|
| 1–2 | OAuth 2.0, OIDC, identity federation | Portal ↔ Keycloak ↔ Verimi login | Trust relationships, identity federation, account linking |
| 3 | Keycloak architecture | Realms, clients, identity providers, authentication flows | Identity provider architecture |
| 4 | Authentication and WebAuthn | Configure passwordless WebAuthn and register a passkey | Authentication factors, phishing resistance, credential lifecycle |
| 5 | Application-Initiated Actions | Trigger passkey enrollment from the portal | Secure credential enrollment and re-authentication |
| 6 | Tokens, sessions and logout | Investigate SSO, token lifetime, logout and session behavior | Distributed session management |
| 7 | RBAC | Implement roles in Keycloak and enforce them in your application | Role-based access control |
| 8 | ABAC | Add user and resource attributes; evaluate authorization decisions | Attribute-based access control |
| 9 | ReBAC | Model relationships between users, organizations and resources | Relationship-based access control |
| 10 | Policy engines | Experiment with OPA or Cedar | Centralized versus application-level authorization |
| 11 | Distributed authorization | Design a Keycloak + application + policy-engine architecture | Consistency, caching, revocation and latency |
| 12 | Research synthesis | Document the architecture and experiments | Formulate research questions |

This is a shift in emphasis, not a change of destination. Your immediate work gives you a concrete way to understand authentication. The later weeks deliberately move from authentication into authorization, because that is where I would still concentrate your longer-term research.

## 4. Turn your work into a small research laboratory

I would maintain one repository, perhaps:

```text
iam-research-lab/
│
├── architecture/
│   ├── system-context.md
│   ├── login-sequence.md
│   ├── passkey-enrollment.md
│   └── trust-boundaries.md
│
├── keycloak/
│   ├── realm-configuration/
│   ├── identity-broker/
│   ├── authentication-flows/
│   └── webauthn/
│
├── experiments/
│   ├── federation/
│   ├── passkey-enrollment/
│   ├── session-management/
│   └── authorization/
│
├── literature/
│
└── research-notes/
```

For every feature you implement, write down four things:

1. **What problem does it solve?**
2. **How does Keycloak implement it?**
3. **What security assumptions does it make?**
4. **What limitations or unanswered questions did you discover?**

For example, your passkey-enrollment experiment could investigate:

| Question | What to investigate |
|---|---|
| Who is allowed to register a passkey? | Authentication state and account ownership |
| How recent must the authentication be? | Session age and re-authentication |
| What happens if enrollment is cancelled? | AIA return status and application behavior |
| What if a passkey is already registered? | Duplicate enrollment and credential management |
| What happens if the user loses the passkey? | Recovery and account recovery |
| Can the user register multiple passkeys? | Credential lifecycle and account security |
| How does the portal know enrollment succeeded? | Credential-state verification |

These are not automatically research questions. They are engineering questions that can help you identify interesting research problems later.

One especially useful distinction to investigate is the difference between **identity proofing, authentication and authorization**:

- Verimi may provide evidence about the user's identity and authenticate that person.
- Keycloak establishes an authenticated session and manages credentials.
- Your portal decides what that authenticated user is allowed to do.

Those are related but different responsibilities. Don't let the fact that Verimi has authenticated someone imply that the person should automatically receive every role or permission in your portal.

Also investigate how your particular Verimi integration identifies users. You want a reliable, stable identifier and a carefully designed account-linking policy; linking accounts solely because email addresses match can create security problems. Check the actual OIDC claims and assurance information provided by your Verimi integration rather than assuming what it supplies.

---

## 5. How to allocate your weekly study time

I would use this allocation:

| Activity | Hours/week |
|---|---:|
| Read the relevant book chapters | 2 |
| Read standards and selected research papers | 1.5 |
| Implement or investigate Keycloak features | 2.5 |
| Write technical and research notes | 1 |
| Review and formulate questions | 0.5 |
| **Total** | **7.5** |

The key is to avoid treating your work project and your independent study as two separate activities.

For example:

- If you spend two hours investigating Keycloak's identity brokering, that counts as practical study.
- If you read about OIDC identity federation, that counts as theoretical study.
- If you document the trust relationship between Verimi and Keycloak, that counts as research preparation.

You are effectively getting three benefits from one activity: professional experience, technical expertise and research preparation.

One boundary is important: keep your independent experiments separate from confidential company material. Recreate the architecture with synthetic users, test data and your own Keycloak environment. Don't publish company configuration, credentials, internal URLs or proprietary implementation details.

---

## 6. Don't let Keycloak become your entire research subject

This is probably the most important advice I can give you.

Your professional work currently involves authentication. Your long-term research interest should remain broader.

I would organize your knowledge into three levels:

| Level | Subject | Your objective |
|---|---|---|
| 1 | Identity and authentication | Understand federation, OIDC, WebAuthn, passkeys, sessions |
| 2 | Authorization | Understand RBAC, ABAC, ReBAC and policy engines |
| 3 | Distributed security architecture | Understand consistency, revocation, caching, trust and policy enforcement |

Keycloak is a useful implementation platform for Level 1 and parts of Level 2. But don't assume that understanding Keycloak means understanding IAM in its entirety.

In particular, I would resist spending too much time on custom Keycloak SPIs, themes, extensions or internal implementation details unless your actual requirements demand them. Learn enough to understand the architecture and use the supported mechanisms correctly.

## 7. My recommended reading order

Given your current project, I would temporarily change the order of the books:

1. **Thorgersen & Silva – *Keycloak: Identity and Access Management for Modern Applications*, second edition.** Read the relevant chapters alongside your implementation.
2. **Wilson & Hingnikar – *Solving Identity Management in Modern Applications*.** Use this to deepen your understanding of federation, OAuth, OIDC and identity lifecycle.
3. **Matt Bishop – *Computer Security: Art and Science*.** Read selectively for the theoretical foundations of access control and security.
4. **Neil Madden – *API Security in Action*.** Use this when you move into authorization, API security and policy enforcement.

For the implementation itself, keep the current [Keycloak Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/) close at hand. It is particularly useful for identity brokering, authentication flows, WebAuthn and application-initiated actions.

---

## My overall recommendation

I would actually make your current project the central practical project for the next six weeks.

By the end of those six weeks, aim to have:

- A working Verimi → Keycloak → portal login.
- A clear understanding of OIDC identity brokering and account linking.
- A working passkey enrollment flow initiated from the portal.
- Passwordless passkey login for subsequent visits.
- A documented security analysis of the complete authentication lifecycle.

Then move on to authorization models and distributed authorization.

**Your long-term research direction remains:**

*Engineering Consistent Authorization in Distributed Systems.*

Your current project gives you a strong foundation in identity federation and authentication. The next step is to understand what happens after authentication: how systems make authorization decisions, how those decisions are distributed, and how they remain consistent when permissions change.

That is the transition I would deliberately work towards. It prevents you from becoming merely a Keycloak specialist when your actual ambition is to become an IAM and security expert.