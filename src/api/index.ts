import { Router } from "express";
import authRouter          from "./routes/auth";
import meRouter            from "./routes/me";
import jobsRouter          from "./routes/jobs";
import cvRouter            from "./routes/cv";
import companiesRouter     from "./routes/companies";
import applyRouter         from "./routes/apply";
import pipelineRouter      from "./routes/pipeline";
import portfolioRouter     from "./routes/portfolio";
import notificationsRouter from "./routes/notifications";
import chatRouter          from "./routes/chat";
import interviewRouter     from "./routes/interview";

const api = Router();

api.use("/auth",          authRouter);
api.use("/me",            meRouter);
api.use("/jobs",          jobsRouter);
api.use("/cv",            cvRouter);
api.use("/companies",     companiesRouter);
api.use("/apply",         applyRouter);
api.use("/pipeline",      pipelineRouter);
api.use("/portfolio",     portfolioRouter);
api.use("/notifications", notificationsRouter);
api.use("/chat",          chatRouter);
api.use("/interview",     interviewRouter);

export default api;
