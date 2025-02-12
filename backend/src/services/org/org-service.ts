import { ForbiddenError } from "@casl/ability";
import slugify from "@sindresorhus/slugify";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Knex } from "knex";

import { OrgMembershipRole, OrgMembershipStatus } from "@app/db/schemas";
import { TProjects } from "@app/db/schemas/projects";
import { TLicenseServiceFactory } from "@app/ee/services/license/license-service";
import { OrgPermissionActions, OrgPermissionSubjects } from "@app/ee/services/permission/org-permission";
import { TPermissionServiceFactory } from "@app/ee/services/permission/permission-service";
import { TSamlConfigDALFactory } from "@app/ee/services/saml-config/saml-config-dal";
import { getConfig } from "@app/lib/config/env";
import { generateAsymmetricKeyPair } from "@app/lib/crypto";
import { generateSymmetricKey, infisicalSymmetricEncypt } from "@app/lib/crypto/encryption";
import { generateUserSrpKeys } from "@app/lib/crypto/srp";
import { BadRequestError, UnauthorizedError } from "@app/lib/errors";
import { alphaNumericNanoId } from "@app/lib/nanoid";
import { isDisposableEmail } from "@app/lib/validator";

import { ActorType, AuthMethod, AuthTokenType } from "../auth/auth-type";
import { TAuthTokenServiceFactory } from "../auth-token/auth-token-service";
import { TokenType } from "../auth-token/auth-token-types";
import { TProjectDALFactory } from "../project/project-dal";
import { SmtpTemplates, TSmtpService } from "../smtp/smtp-service";
import { TUserDALFactory } from "../user/user-dal";
import { TIncidentContactsDALFactory } from "./incident-contacts-dal";
import { TOrgBotDALFactory } from "./org-bot-dal";
import { TOrgDALFactory } from "./org-dal";
import { TOrgRoleDALFactory } from "./org-role-dal";
import {
  TDeleteOrgMembershipDTO,
  TFindAllWorkspacesDTO,
  TFindOrgMembersByEmailDTO,
  TInviteUserToOrgDTO,
  TUpdateOrgDTO,
  TUpdateOrgMembershipDTO,
  TVerifyUserToOrgDTO
} from "./org-types";

type TOrgServiceFactoryDep = {
  orgDAL: TOrgDALFactory;
  orgBotDAL: TOrgBotDALFactory;
  orgRoleDAL: TOrgRoleDALFactory;
  userDAL: TUserDALFactory;
  projectDAL: TProjectDALFactory;
  incidentContactDAL: TIncidentContactsDALFactory;
  samlConfigDAL: Pick<TSamlConfigDALFactory, "findOne" | "findEnforceableSamlCfg">;
  smtpService: TSmtpService;
  tokenService: TAuthTokenServiceFactory;
  permissionService: TPermissionServiceFactory;
  licenseService: Pick<
    TLicenseServiceFactory,
    "getPlan" | "updateSubscriptionOrgMemberCount" | "generateOrgCustomerId" | "removeOrgCustomer"
  >;
};

export type TOrgServiceFactory = ReturnType<typeof orgServiceFactory>;

export const orgServiceFactory = ({
  orgDAL,
  userDAL,
  orgRoleDAL,
  incidentContactDAL,
  permissionService,
  smtpService,
  projectDAL,
  tokenService,
  orgBotDAL,
  licenseService,
  samlConfigDAL
}: TOrgServiceFactoryDep) => {
  /*
   * Get organization details by the organization id
   * */
  const findOrganizationById = async (userId: string, orgId: string, actorOrgId?: string) => {
    await permissionService.getUserOrgPermission(userId, orgId, actorOrgId);
    const org = await orgDAL.findOrgById(orgId);
    if (!org) throw new BadRequestError({ name: "Org not found", message: "Organization not found" });
    return org;
  };
  /*
   * Get all organization a user part of
   * */
  const findAllOrganizationOfUser = async (userId: string) => {
    const orgs = await orgDAL.findAllOrgsByUserId(userId);
    return orgs;
  };
  /*
   * Get all workspace members
   * */
  const findAllOrgMembers = async (userId: string, orgId: string, actorOrgId?: string) => {
    const { permission } = await permissionService.getUserOrgPermission(userId, orgId, actorOrgId);
    ForbiddenError.from(permission).throwUnlessCan(OrgPermissionActions.Read, OrgPermissionSubjects.Member);

    const members = await orgDAL.findAllOrgMembers(orgId);
    return members;
  };

  const findOrgMembersByEmail = async ({ actor, actorId, orgId, emails }: TFindOrgMembersByEmailDTO) => {
    const { permission } = await permissionService.getOrgPermission(actor, actorId, orgId);
    ForbiddenError.from(permission).throwUnlessCan(OrgPermissionActions.Read, OrgPermissionSubjects.Member);

    const members = await orgDAL.findOrgMembersByEmail(orgId, emails);

    return members;
  };

  const findAllWorkspaces = async ({ actor, actorId, actorOrgId, orgId }: TFindAllWorkspacesDTO) => {
    const { permission } = await permissionService.getOrgPermission(actor, actorId, orgId, actorOrgId);
    ForbiddenError.from(permission).throwUnlessCan(OrgPermissionActions.Read, OrgPermissionSubjects.Workspace);

    const organizationWorkspaceIds = new Set((await projectDAL.find({ orgId })).map((workspace) => workspace.id));

    let workspaces: (TProjects & { organization: string } & {
      environments: {
        id: string;
        slug: string;
        name: string;
      }[];
    })[];

    if (actor === ActorType.USER) {
      workspaces = await projectDAL.findAllProjects(actorId);
    } else if (actor === ActorType.IDENTITY) {
      workspaces = await projectDAL.findAllProjectsByIdentity(actorId);
    } else {
      throw new BadRequestError({ message: "Invalid actor type" });
    }

    return workspaces.filter((workspace) => organizationWorkspaceIds.has(workspace.id));
  };

  const addGhostUser = async (orgId: string, tx?: Knex) => {
    const email = `sudo-${alphaNumericNanoId(16)}-${orgId}@infisical.com`; // We add a nanoid because the email is unique. And we have to create a new ghost user each time, so we can have access to the private key.
    const password = crypto.randomBytes(128).toString("hex");

    const user = await userDAL.create(
      {
        isGhost: true,
        authMethods: [AuthMethod.EMAIL],
        email,
        isAccepted: true
      },
      tx
    );

    const encKeys = await generateUserSrpKeys(email, password);

    await userDAL.upsertUserEncryptionKey(
      user.id,
      {
        encryptionVersion: 2,
        protectedKey: encKeys.protectedKey,
        protectedKeyIV: encKeys.protectedKeyIV,
        protectedKeyTag: encKeys.protectedKeyTag,
        publicKey: encKeys.publicKey,
        encryptedPrivateKey: encKeys.encryptedPrivateKey,
        iv: encKeys.encryptedPrivateKeyIV,
        tag: encKeys.encryptedPrivateKeyTag,
        salt: encKeys.salt,
        verifier: encKeys.verifier
      },
      tx
    );

    const createMembershipData = {
      orgId,
      userId: user.id,
      role: OrgMembershipRole.Admin,
      status: OrgMembershipStatus.Accepted
    };

    await orgDAL.createMembership(createMembershipData, tx);

    return {
      user,
      keys: encKeys
    };
  };

  /*
   * Update organization details
   * */
  const updateOrg = async ({
    actor,
    actorId,
    actorOrgId,
    orgId,
    data: { name, slug, authEnforced, scimEnabled }
  }: TUpdateOrgDTO) => {
    const { permission } = await permissionService.getOrgPermission(actor, actorId, orgId, actorOrgId);
    ForbiddenError.from(permission).throwUnlessCan(OrgPermissionActions.Edit, OrgPermissionSubjects.Settings);

    const plan = await licenseService.getPlan(orgId);

    if (authEnforced !== undefined) {
      if (!plan?.samlSSO)
        throw new BadRequestError({
          message:
            "Failed to enforce/un-enforce SAML SSO due to plan restriction. Upgrade plan to enforce/un-enforce SAML SSO."
        });
      ForbiddenError.from(permission).throwUnlessCan(OrgPermissionActions.Edit, OrgPermissionSubjects.Sso);
    }

    if (scimEnabled !== undefined) {
      if (!plan?.scim)
        throw new BadRequestError({
          message:
            "Failed to enable/disable SCIM provisioning due to plan restriction. Upgrade plan to enable/disable SCIM provisioning."
        });
      ForbiddenError.from(permission).throwUnlessCan(OrgPermissionActions.Edit, OrgPermissionSubjects.Scim);
    }

    if (authEnforced || scimEnabled) {
      const samlCfg = await samlConfigDAL.findEnforceableSamlCfg(orgId);
      if (!samlCfg)
        throw new BadRequestError({
          name: "No enforceable SAML config found",
          message: "No enforceable SAML config found"
        });
    }

    const org = await orgDAL.updateById(orgId, {
      name,
      slug: slug ? slugify(slug) : undefined,
      authEnforced,
      scimEnabled
    });
    if (!org) throw new BadRequestError({ name: "Org not found", message: "Organization not found" });
    return org;
  };
  /*
   * Create organization
   * */
  const createOrganization = async (userId: string, userEmail: string, orgName: string) => {
    const { privateKey, publicKey } = generateAsymmetricKeyPair();
    const key = generateSymmetricKey();
    const {
      ciphertext: encryptedPrivateKey,
      iv: privateKeyIV,
      tag: privateKeyTag,
      encoding: privateKeyKeyEncoding,
      algorithm: privateKeyAlgorithm
    } = infisicalSymmetricEncypt(privateKey);
    const {
      ciphertext: encryptedSymmetricKey,
      iv: symmetricKeyIV,
      tag: symmetricKeyTag,
      encoding: symmetricKeyKeyEncoding,
      algorithm: symmetricKeyAlgorithm
    } = infisicalSymmetricEncypt(key);

    const customerId = await licenseService.generateOrgCustomerId(orgName, userEmail);
    const organization = await orgDAL.transaction(async (tx) => {
      // akhilmhdh: for now this is auto created. in future we can input from user and for previous users just modifiy
      const org = await orgDAL.create(
        { name: orgName, customerId, slug: slugify(`${orgName}-${alphaNumericNanoId(4)}`) },
        tx
      );
      await orgDAL.createMembership(
        {
          userId,
          orgId: org.id,
          role: OrgMembershipRole.Admin,
          status: OrgMembershipStatus.Accepted
        },
        tx
      );
      await orgBotDAL.create(
        {
          name: org.name,
          publicKey,
          privateKeyIV,
          encryptedPrivateKey,
          symmetricKeyIV,
          symmetricKeyTag,
          encryptedSymmetricKey,
          symmetricKeyAlgorithm,
          orgId: org.id,
          privateKeyTag,
          privateKeyAlgorithm,
          privateKeyKeyEncoding,
          symmetricKeyKeyEncoding
        },
        tx
      );
      return org;
    });

    return organization;
  };

  /*
   * Delete organization by id
   * */
  const deleteOrganizationById = async (userId: string, orgId: string, actorOrgId?: string) => {
    const { membership } = await permissionService.getUserOrgPermission(userId, orgId, actorOrgId);
    if ((membership.role as OrgMembershipRole) !== OrgMembershipRole.Admin)
      throw new UnauthorizedError({ name: "Delete org by id", message: "Not an admin" });

    const organization = await orgDAL.deleteById(orgId);
    if (organization.customerId) {
      await licenseService.removeOrgCustomer(organization.customerId);
    }
    return organization;
  };
  /*
   * Org membership management
   * Not another service because it has close ties with how an org works doesn't make sense to seperate them
   * */
  const updateOrgMembership = async ({ role, orgId, userId, membershipId, actorOrgId }: TUpdateOrgMembershipDTO) => {
    const { permission } = await permissionService.getUserOrgPermission(userId, orgId, actorOrgId);
    ForbiddenError.from(permission).throwUnlessCan(OrgPermissionActions.Edit, OrgPermissionSubjects.Member);

    const isCustomRole = !Object.values(OrgMembershipRole).includes(role as OrgMembershipRole);
    if (isCustomRole) {
      const customRole = await orgRoleDAL.findOne({ slug: role, orgId });
      if (!customRole) throw new BadRequestError({ name: "Update membership", message: "Role not found" });

      const plan = await licenseService.getPlan(orgId);
      if (!plan?.rbac)
        throw new BadRequestError({
          message: "Failed to assign custom role due to RBAC restriction. Upgrade plan to assign custom role to member."
        });

      const [membership] = await orgDAL.updateMembership(
        { id: membershipId, orgId },
        {
          role: OrgMembershipRole.Custom,
          roleId: customRole.id
        }
      );
      return membership;
    }

    const [membership] = await orgDAL.updateMembership({ id: membershipId, orgId }, { role, roleId: null });
    return membership;
  };
  /*
   * Invite user to organization
   */
  const inviteUserToOrganization = async ({ orgId, userId, inviteeEmail, actorOrgId }: TInviteUserToOrgDTO) => {
    const { permission } = await permissionService.getUserOrgPermission(userId, orgId, actorOrgId);
    ForbiddenError.from(permission).throwUnlessCan(OrgPermissionActions.Create, OrgPermissionSubjects.Member);

    const org = await orgDAL.findOrgById(orgId);

    if (org?.authEnforced) {
      throw new BadRequestError({
        message: "Failed to invite user due to org-level auth enforced for organization"
      });
    }

    const plan = await licenseService.getPlan(orgId);
    if (plan.memberLimit !== null && plan.membersUsed >= plan.memberLimit) {
      // case: limit imposed on number of members allowed
      // case: number of members used exceeds the number of members allowed
      throw new BadRequestError({
        message: "Failed to invite member due to member limit reached. Upgrade plan to invite more members."
      });
    }
    const invitee = await orgDAL.transaction(async (tx) => {
      const inviteeUser = await userDAL.findUserByEmail(inviteeEmail, tx);
      if (inviteeUser) {
        // if user already exist means its already part of infisical
        // Thus the signup flow is not needed anymore
        const [inviteeMembership] = await orgDAL.findMembership({ orgId, userId: inviteeUser.id }, { tx });
        if (inviteeMembership && inviteeMembership.status === OrgMembershipStatus.Accepted) {
          throw new BadRequestError({
            message: "Failed to invite an existing member of org",
            name: "Invite user to org"
          });
        }

        if (!inviteeMembership) {
          await orgDAL.createMembership(
            {
              userId: inviteeUser.id,
              inviteEmail: inviteeEmail,
              orgId,
              role: OrgMembershipRole.Member,
              status: OrgMembershipStatus.Invited
            },
            tx
          );
        }
        return inviteeUser;
      }
      const isEmailInvalid = await isDisposableEmail(inviteeEmail);
      if (isEmailInvalid) {
        throw new BadRequestError({
          message: "Provided a disposable email",
          name: "Org invite"
        });
      }
      // not invited before
      const user = await userDAL.create(
        {
          email: inviteeEmail,
          isAccepted: false,
          authMethods: [AuthMethod.EMAIL],
          isGhost: false
        },
        tx
      );
      await orgDAL.createMembership(
        {
          inviteEmail: inviteeEmail,
          orgId,
          userId: user.id,
          role: OrgMembershipRole.Member,
          status: OrgMembershipStatus.Invited
        },
        tx
      );
      return user;
    });

    const token = await tokenService.createTokenForUser({
      type: TokenType.TOKEN_EMAIL_ORG_INVITATION,
      userId: invitee.id,
      orgId
    });

    const user = await userDAL.findById(userId);
    const appCfg = getConfig();
    await smtpService.sendMail({
      template: SmtpTemplates.OrgInvite,
      subjectLine: "Infisical organization invitation",
      recipients: [inviteeEmail],
      substitutions: {
        inviterFirstName: user.firstName,
        inviterEmail: user.email,
        organizationName: org?.name,
        email: inviteeEmail,
        organizationId: org?.id.toString(),
        token,
        callback_url: `${appCfg.SITE_URL}/signupinvite`
      }
    });

    await licenseService.updateSubscriptionOrgMemberCount(orgId);
    if (!appCfg.isSmtpConfigured) {
      return `${appCfg.SITE_URL}/signupinvite?token=${token}&to=${inviteeEmail}&organization_id=${org?.id}`;
    }
  };

  /**
   * Organization invitation step 2: Verify that code [code] was sent to email [email] as part of
   * magic link and issue a temporary signup token for user to complete setting up their account
   */
  const verifyUserToOrg = async ({ orgId, email, code }: TVerifyUserToOrgDTO) => {
    const user = await userDAL.findUserByEmail(email);
    if (!user) {
      throw new BadRequestError({ message: "Invalid request", name: "Verify user to org" });
    }
    const [orgMembership] = await orgDAL.findMembership({
      userId: user.id,
      status: OrgMembershipStatus.Invited,
      orgId
    });
    if (!orgMembership)
      throw new BadRequestError({
        message: "Failed to find invitation",
        name: "Verify user to org"
      });

    await tokenService.validateTokenForUser({
      type: TokenType.TOKEN_EMAIL_ORG_INVITATION,
      userId: user.id,
      orgId: orgMembership.orgId,
      code
    });

    if (user.isAccepted) {
      // this means user has already completed signup process
      // isAccepted is set true when keys are exchanged
      await orgDAL.updateMembershipById(orgMembership.id, {
        orgId,
        status: OrgMembershipStatus.Accepted
      });
      await licenseService.updateSubscriptionOrgMemberCount(orgId);
      return { user };
    }

    const appCfg = getConfig();
    const token = jwt.sign(
      {
        authTokenType: AuthTokenType.SIGNUP_TOKEN,
        userId: user.id
      },
      appCfg.AUTH_SECRET,
      {
        expiresIn: appCfg.JWT_SIGNUP_LIFETIME
      }
    );

    return { token, user };
  };

  const deleteOrgMembership = async ({ orgId, userId, membershipId, actorOrgId }: TDeleteOrgMembershipDTO) => {
    const { permission } = await permissionService.getUserOrgPermission(userId, orgId, actorOrgId);
    ForbiddenError.from(permission).throwUnlessCan(OrgPermissionActions.Delete, OrgPermissionSubjects.Member);

    const membership = await orgDAL.deleteMembershipById(membershipId, orgId);

    await licenseService.updateSubscriptionOrgMemberCount(orgId);
    return membership;
  };

  /*
   * CRUD operations of incident contacts
   * */
  const findIncidentContacts = async (userId: string, orgId: string, actorOrgId?: string) => {
    const { permission } = await permissionService.getUserOrgPermission(userId, orgId, actorOrgId);
    ForbiddenError.from(permission).throwUnlessCan(OrgPermissionActions.Read, OrgPermissionSubjects.IncidentAccount);
    const incidentContacts = await incidentContactDAL.findByOrgId(orgId);
    return incidentContacts;
  };

  const createIncidentContact = async (userId: string, orgId: string, email: string, actorOrgId?: string) => {
    const { permission } = await permissionService.getUserOrgPermission(userId, orgId, actorOrgId);
    ForbiddenError.from(permission).throwUnlessCan(OrgPermissionActions.Create, OrgPermissionSubjects.IncidentAccount);
    const doesIncidentContactExist = await incidentContactDAL.findOne(orgId, { email });
    if (doesIncidentContactExist) {
      throw new BadRequestError({
        message: "Incident contact already exist",
        name: "Incident contact exist"
      });
    }

    const incidentContact = await incidentContactDAL.create(orgId, email);
    return incidentContact;
  };

  const deleteIncidentContact = async (userId: string, orgId: string, id: string, actorOrgId?: string) => {
    const { permission } = await permissionService.getUserOrgPermission(userId, orgId, actorOrgId);
    ForbiddenError.from(permission).throwUnlessCan(OrgPermissionActions.Delete, OrgPermissionSubjects.IncidentAccount);

    const incidentContact = await incidentContactDAL.deleteById(id, orgId);
    return incidentContact;
  };

  return {
    findOrganizationById,
    findAllOrgMembers,
    findAllOrganizationOfUser,
    inviteUserToOrganization,
    verifyUserToOrg,
    updateOrg,
    findOrgMembersByEmail,
    createOrganization,
    deleteOrganizationById,
    deleteOrgMembership,
    findAllWorkspaces,
    addGhostUser,
    updateOrgMembership,
    // incident contacts
    findIncidentContacts,
    createIncidentContact,
    deleteIncidentContact
  };
};
