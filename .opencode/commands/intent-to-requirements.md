---
description: Draft requirements from intent
model: opencode/big-pickle
---

Use this Engineering Intent Document to draft clear software requirments.

Intent: `/home/think/Dev/ai/ideas/hotBox2/docs/intent.md`

Return:
- functional requirements 
- non-functional requirements
- business rules
- permissions
- constraints
- acceptance criteria

(see the points below for more details of how each points should be written)

Do not choose implementation tools yet

# Functional requirements

A good functional requirement usally includes an actor, an action, an object, and a result. For example:

"A project manager must be able to assign a task to a team member so the team member can see their responsibility."

## Actor

The one who performs the action, e.g. project manager

## Action

What the actor must do, e.g. assign a task

## Object

What is being acted on, e.g. A task record

## Result/ outcome

What should happen after the action, e.g. The assigned user can see the task

## Example functional requirment format

REQ-F-001: [Actor] must be able to [Action] [object] so that [business or user outcome]

Exmaple: 

REQ-F-001: A team member must be able to create a task with a title, description, due date, and status so that work can be tracked clearly.

# Non-Functional requirements

Non-functional requirements describe how well the system must work. They do not usually describe a feature. Instead, they describe quality conditions such as speed, security, reliability, accessibility, usability, privacy, and maintainability.

# User roles and Permissions

User roles define who uses the system. Permissions define what each role can do. 

## Example 

Role requirement example:

REQ-R-001: The system must support four roles: Owner, Project Manager, Team Member, and Viewer

REQ-R-002: A Viewer must be able to read assigned project information but must not create, edit, assign, or delete tasks

# Business Rules

Business rules are decisions about ow the organization or product should operate. They are not just technical choices. They describe policies the software must enforce.

## Example

- A task due date cannot be earlier than today when the task is created

# Constraints

A constraint is a fixed condition that limits the solution. Cnstraints may come from budget, deadlines, technology choices, compliance needs, device support, team skills, hosting limits, or integration requirements.

## Example for constraints:
- Technology (ReactJS, Kotlin, etc.)
- Time (the first version must be small enough to be built within a week)
- Data (The system must not store payment card details)
- Environment (the application must run on a low-cost cloud instance)
- Integration (The syxtem must export task data as CSV)

# Acceptance Criteria

Acceptance criteria describe how you will know a requirment has been met. They turn a requirment into something testable. A simple way to write acceptance criteria is the Given-When-Then format. Given describes the starting condition. When describes the action. Then describes the expected result.

## Example
Requirment:
A team member must be able to create a task

-> Acceptance criteria:
Given a signed-in team member, when they submit a valid task form, then the task is saved and shown in the task list.

## Acceptance criteria format
Examples:

AC-001:
Given [starting condition], 
When [user action or system event],
Then [expected result]

AC-002:
Given [edge case or failure condition],
When [action occurs],
Then [safe behaviour or error response]


# Before creating 

# Return
Write what you want to return into the following file: `/home/think/Dev/ai/ideas/hotBox2/docs/requirements.md`
