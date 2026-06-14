import { Router, type IRouter } from "express";
import healthRouter from "./health";
import shellRouter from "./shell";
import vmRouter from "./vm";
import odysseusProxyRouter from "./odysseus-proxy";
import odysseusLifecycleRouter from "./odysseus-lifecycle";
import filesRouter from "./files";
import releaseRouter from "./release";

const router: IRouter = Router();

router.use(healthRouter);
router.use(shellRouter);
router.use(vmRouter);
router.use(filesRouter);
router.use(releaseRouter);
router.use(odysseusLifecycleRouter);
router.use(odysseusProxyRouter);

export default router;
