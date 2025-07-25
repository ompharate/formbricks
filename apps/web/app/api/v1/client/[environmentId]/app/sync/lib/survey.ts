import "server-only";
import { getProjectByEnvironmentId } from "@/lib/project/service";
import { getSurveys } from "@/lib/survey/service";
import { anySurveyHasFilters } from "@/lib/survey/utils";
import { diffInDays } from "@/lib/utils/datetime";
import { validateInputs } from "@/lib/utils/validate";
import { evaluateSegment } from "@/modules/ee/contacts/segments/lib/segments";
import { Prisma } from "@prisma/client";
import { cache as reactCache } from "react";
import { prisma } from "@formbricks/database";
import { logger } from "@formbricks/logger";
import { ZId } from "@formbricks/types/common";
import { DatabaseError, ResourceNotFoundError } from "@formbricks/types/errors";
import { TSurvey } from "@formbricks/types/surveys/types";

export const getSyncSurveys = reactCache(
  async (
    environmentId: string,
    contactId: string,
    contactAttributes: Record<string, string | number>,
    deviceType: "phone" | "desktop" = "desktop"
  ): Promise<TSurvey[]> => {
    validateInputs([environmentId, ZId]);
    try {
      const project = await getProjectByEnvironmentId(environmentId);

      if (!project) {
        throw new Error("Project not found");
      }

      let surveys = await getSurveys(environmentId);

      // filtered surveys for running and web
      surveys = surveys.filter((survey) => survey.status === "inProgress" && survey.type === "app");

      // if no surveys are left, return an empty array
      if (surveys.length === 0) {
        return [];
      }

      const displays = await prisma.display.findMany({
        where: {
          contactId,
        },
      });

      const responses = await prisma.response.findMany({
        where: {
          contactId,
        },
      });

      // filter surveys that meet the displayOption criteria
      surveys = surveys.filter((survey) => {
        switch (survey.displayOption) {
          case "respondMultiple":
            return true;
          case "displayOnce":
            return displays.filter((display) => display.surveyId === survey.id).length === 0;
          case "displayMultiple":
            if (!responses) return true;
            else {
              return responses.filter((response) => response.surveyId === survey.id).length === 0;
            }
          case "displaySome":
            if (survey.displayLimit === null) {
              return true;
            }

            if (responses && responses.filter((response) => response.surveyId === survey.id).length !== 0) {
              return false;
            }

            return displays.filter((display) => display.surveyId === survey.id).length < survey.displayLimit;
          default:
            throw Error("Invalid displayOption");
        }
      });

      const latestDisplay = displays[0];

      // filter surveys that meet the recontactDays criteria
      surveys = surveys.filter((survey) => {
        if (!latestDisplay) {
          return true;
        } else if (survey.recontactDays !== null) {
          const lastDisplaySurvey = displays.filter((display) => display.surveyId === survey.id)[0];
          if (!lastDisplaySurvey) {
            return true;
          }
          return diffInDays(new Date(), new Date(lastDisplaySurvey.createdAt)) >= survey.recontactDays;
        } else if (project.recontactDays !== null) {
          return diffInDays(new Date(), new Date(latestDisplay.createdAt)) >= project.recontactDays;
        } else {
          return true;
        }
      });

      // if no surveys are left, return an empty array
      if (surveys.length === 0) {
        return [];
      }

      // if no surveys have segment filters, return the surveys
      if (!anySurveyHasFilters(surveys)) {
        return surveys;
      }

      // the surveys now have segment filters, so we need to evaluate them
      const surveyPromises = surveys.map(async (survey) => {
        const { segment } = survey;
        // if the survey has no segment, or the segment has no filters, we return the survey
        if (!segment || !segment.filters?.length) {
          return survey;
        }

        // Evaluate the segment filters
        const result = await evaluateSegment(
          {
            attributes: contactAttributes ?? {},
            deviceType,
            environmentId,
            contactId,
            userId: String(contactAttributes.userId),
          },
          segment.filters
        );

        return result ? survey : null;
      });

      const resolvedSurveys = await Promise.all(surveyPromises);
      surveys = resolvedSurveys.filter((survey) => !!survey) as TSurvey[];

      if (!surveys) {
        throw new ResourceNotFoundError("Survey", environmentId);
      }
      return surveys;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        logger.error(error);
        throw new DatabaseError(error.message);
      }

      throw error;
    }
  }
);
